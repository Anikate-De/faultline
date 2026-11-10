import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_H2_MS = 120;
const BASE_H3_MS = 120;
const H2_RTT_MULTIPLE = 3;
const H3_RTT_MULTIPLE = 2;
const H2_LOSS_MULTIPLE = 100;
const H3_LOSS_MULTIPLE = 8;

const params = [
  {
    id: "packetLoss",
    label: "Packet loss",
    min: 0,
    max: 10,
    step: 0.5,
    value: 1,
    unit: "%",
    group: "Network",
    help: "End-to-end packet loss on the client path. TCP loss stalls every stream on the connection; QUIC loss stalls the affected stream and shares congestion control.",
    format: "percent" as const,
  },
  {
    id: "rttMs",
    label: "Round-trip time",
    min: 20,
    max: 300,
    step: 10,
    value: 60,
    unit: " ms",
    group: "Network",
    help: "One network round trip. A new TCP and TLS 1.3 handshake needs two round trips; a QUIC handshake needs one.",
    format: "ms" as const,
  },
  {
    id: "http3Share",
    label: "Clients attempting HTTP/3",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Rollout",
    help: "Share of clients that discover and attempt HTTP/3. The rest use HTTP/2 over TCP.",
    format: "percent" as const,
  },
  {
    id: "udpBlockedShare",
    label: "Clients with UDP blocked",
    min: 0,
    max: 50,
    step: 1,
    value: 5,
    unit: "%",
    group: "Network",
    help: "Share of clients whose network blocks UDP 443. Without fallback, an HTTP/3 attempt on these clients cannot complete.",
    format: "percent" as const,
  },
  {
    id: "fallbackEnabled",
    label: "Fallback to HTTP/2 (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rollout",
    help: "Retry over TCP with HTTP/2 when QUIC cannot connect. Fallback preserves availability but those clients pay TCP latency.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  loss: number;
  rtt: number;
  http3Share: number;
  udpBlocked: number;
  fallback: boolean;
  h2P99: number;
  h3P99: number;
  blockedShare: number;
  failedShare: number;
  degradedShare: number;
  effectiveH3Share: number;
  h3Adoption: number;
  blendedP99: number;
  setupAdvantage: number;
}

function compute(p: Params): Computed {
  const loss = Math.min(10, Math.max(0, num(p, "packetLoss", 1)));
  const rtt = Math.max(1, num(p, "rttMs", 60));
  const http3Share = Math.min(100, Math.max(0, num(p, "http3Share", 80)));
  const udpBlocked = Math.min(50, Math.max(0, num(p, "udpBlockedShare", 5)));
  const fallback = num(p, "fallbackEnabled", 1) >= 0.5;

  const h2P99 = BASE_H2_MS + H2_RTT_MULTIPLE * rtt + (loss / 100) * H2_LOSS_MULTIPLE * rtt;
  const h3P99 = BASE_H3_MS + H3_RTT_MULTIPLE * rtt + (loss / 100) * H3_LOSS_MULTIPLE * rtt;

  const blockedShare = (http3Share / 100) * (udpBlocked / 100);
  const failedShare = fallback ? 0 : blockedShare * 100;
  const degradedShare = fallback ? blockedShare * 100 : 0;
  const effectiveH3Share = Math.max(0, http3Share / 100 - blockedShare);
  const h2Share = 1 - http3Share / 100;
  const fallbackShare = fallback ? blockedShare : 0;
  const successfulShare = effectiveH3Share + h2Share + fallbackShare;
  const h3Adoption = successfulShare > 0 ? (effectiveH3Share / successfulShare) * 100 : 0;
  const blendedP99 =
    successfulShare > 0
      ? (effectiveH3Share * h3P99 + (h2Share + fallbackShare) * h2P99) / successfulShare
      : h3P99;
  const setupAdvantage = Math.max(0, 2 * rtt - rtt);

  return {
    loss,
    rtt,
    http3Share,
    udpBlocked,
    fallback,
    h2P99,
    h3P99,
    blockedShare,
    failedShare,
    degradedShare,
    effectiveH3Share,
    h3Adoption,
    blendedP99,
    setupAdvantage,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const clientHealth = healthFor(d.failedShare, 0.5, 2);
  const edgeHealth =
    d.failedShare >= 2 ? "crit" : d.degradedShare >= 10 || d.h3P99 >= 500 ? "warn" : "ok";
  const originHealth = "ok";

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client fleet",
        kind: "client",
        health: clientHealth,
        sublabel: `${d.http3Share.toFixed(0)}% attempt HTTP/3`,
        detail: `${d.udpBlocked.toFixed(0)}% of clients are behind networks that block UDP 443. ${d.fallback ? "Those clients fall back to HTTP/2 over TCP." : "Without fallback, those attempts fail."}`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "QUIC edge",
        kind: "cdn",
        health: edgeHealth,
        sublabel: `${d.h3Adoption.toFixed(0)}% of successful sessions on HTTP/3`,
        detail: `QUIC runs over UDP and multiplexes independent streams. Loss on one stream does not block the others at the transport layer, but congestion control and the lost packet still cost time.`,
        meta: { view: "flow" },
      },
      {
        id: "origin",
        label: "HTTP/2 origin path",
        kind: "service",
        health: originHealth,
        sublabel: d.fallback ? "TCP fallback available" : "TCP path is the only fallback",
        detail: "TCP delivers one ordered byte stream. A lost segment stalls every HTTP/2 stream on that connection until it is recovered. The origin application is healthy; the transport tail is shown in the p99 metrics.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", clamp(d.http3Share / 100), clientHealth),
      edge("edge-origin", "edge", "origin", clamp(1 - d.http3Share / 100 + d.degradedShare / 100), originHealth),
    ],
    metrics: [
      metric("h2-p99", "HTTP/2 p99", d.h2P99, "ms", 500, 1_000, "ms"),
      metric("h3-p99", "HTTP/3 p99", d.h3P99, "ms", 500, 1_000, "ms"),
      metric("session-failures", "Failed sessions", d.failedShare, "%", 0.5, 2, "percent"),
      metric("degraded-share", "Sessions falling back to HTTP/2", d.degradedShare, "%", 10, 30, "percent"),
      metric("h3-adoption", "Successful sessions on HTTP/3", d.h3Adoption, "%", undefined, undefined, "percent"),
      metric("blended-p99", "Blended p99 across successful sessions", d.blendedP99, "ms", undefined, undefined, "ms"),
      metric("setup-advantage", "Handshake advantage", d.setupAdvantage, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), fallback: d.fallback ? 1 : 0, http3Share: d.http3Share },
    summary: `${d.failedShare.toFixed(1)}% failed sessions; ${d.degradedShare.toFixed(1)}% fall back; HTTP/2 p99 ${d.h2P99.toFixed(0)}ms vs HTTP/3 p99 ${d.h3P99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 5)) / 2.2)) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "session-failures",
    metricId: "session-failures",
    warn: 0.5,
    crit: 2,
    title: "HTTP/3 attempts are failing instead of falling back",
    cause:
      "A share of clients is behind a network that blocks UDP 443, and the client or edge has no TCP fallback. The QUIC handshake cannot complete, so the session never reaches HTTP semantics.",
    fix:
      "Enable fallback to HTTP/2 over TCP, advertise HTTP/3 only as an alternative, and verify that blocked clients still connect. Do not require UDP for the critical path.",
    checkFirst: [
      "Separate session failures by network type or client region.",
      "Check whether UDP 443 egress is blocked and whether fallback is configured.",
      "Confirm the client attempted HTTP/3 through an alternative-service advertisement rather than a hard-coded transport.",
    ],
  },
  {
    id: "degraded-share",
    metricId: "degraded-share",
    warn: 10,
    crit: 30,
    title: "A large share of clients is falling back to TCP",
    cause:
      "UDP is blocked or unreliable for these clients, so the HTTP/3 attempt loses the handshake advantage and completes over HTTP/2. Availability is preserved, but the loss and head-of-line behavior are back.",
    fix:
      "Treat fallback as a designed path: measure its share, keep the HTTP/2 path warm, and investigate whether the blocked population is a network policy or a provider issue.",
    checkFirst: [
      "Compare fallback share with network type, carrier, and region.",
      "Check UDP 443 reachability from the affected networks.",
      "Compare HTTP/2 p99 for the fallback population with the HTTP/3 population.",
    ],
  },
  {
    id: "h2-p99",
    metricId: "h2-p99",
    warn: 500,
    crit: 1_000,
    title: "TCP head-of-line blocking dominates the tail",
    cause:
      "On a lossy path, one lost TCP segment stalls every HTTP/2 stream on the connection while it is retransmitted. The application has no slow span; the transport is waiting.",
    fix:
      "Use HTTP/3 where the network allows it, keep fallback for the rest, and reduce dependence on a single TCP connection for latency-critical resources.",
    checkFirst: [
      "Compare loss and retransmit rate with p99.",
      "Check whether the tail is on new connections or on reused ones.",
      "Compare the same request over HTTP/3 and HTTP/2 from the affected network.",
    ],
  },
  {
    id: "h3-p99",
    metricId: "h3-p99",
    warn: 500,
    crit: 1_000,
    title: "QUIC loss recovery is still costing the tail",
    cause:
      "QUIC removes cross-stream head-of-line blocking but not loss. A lost packet stalls the stream whose data it carried, and congestion control reduces the sending rate for the connection.",
    fix:
      "Do not treat HTTP/3 as loss immunity. Measure per-stream stalls, check congestion and retransmit behavior, and fix the path or server capacity if loss is self-inflicted.",
    checkFirst: [
      "Check packet loss and retransmit rate on the QUIC path.",
      "Check whether one stream or the whole connection stalls.",
      "Compare p99 across client networks, not only in a clean lab.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const http3Model: SimModel = {
  id: "traffic-http3-quic",
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
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "h3-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.series = {};
    for (const item of next.metrics) {
      const previous = frame.series[item.id] ?? [];
      next.series[item.id] = [...previous, item.value].slice(-120);
    }

    if (d.failedShare > 0 && next.flags.failureWarned !== 1) {
      pushEvent(next, {
        id: "udp-blocked-no-fallback",
        at: frame.t,
        severity: "crit",
        title: "UDP-blocked clients cannot complete HTTP/3",
        detail: `${d.failedShare.toFixed(1)}% of sessions fail because UDP 443 is blocked and fallback is off. The other ${(100 - d.failedShare).toFixed(1)}% can still use HTTP/3 or HTTP/2.`,
        nodeId: "edge",
        metricId: "session-failures",
      });
      next.flags.failureWarned = 1;
    }
    if (d.failedShare === 0) next.flags.failureWarned = 0;

    if (d.degradedShare > 0 && next.flags.fallbackWarned !== 1) {
      pushEvent(next, {
        id: "fallback-active",
        at: frame.t,
        severity: "warn",
        title: "UDP-blocked clients fell back to HTTP/2",
        detail: `${d.degradedShare.toFixed(1)}% of sessions use TCP fallback. Availability is preserved, but those clients pay HTTP/2 latency of about ${d.h2P99.toFixed(0)}ms.`,
        nodeId: "origin",
        metricId: "degraded-share",
      });
      next.flags.fallbackWarned = 1;
    }
    if (d.degradedShare === 0) next.flags.fallbackWarned = 0;

    const previousFallback = Number(frame.flags.fallback ?? 1);
    if ((d.fallback ? 1 : 0) !== previousFallback) {
      pushEvent(next, {
        id: "fallback-change",
        at: frame.t,
        severity: "info",
        title: d.fallback ? "HTTP/2 fallback enabled" : "HTTP/2 fallback disabled",
        detail: d.fallback
          ? "Clients that cannot establish QUIC retry over TCP with HTTP/2. Blocked sessions become slower instead of failing."
          : "Clients that cannot establish QUIC have no alternate path in this model, so their sessions fail.",
        nodeId: "client",
      });
    }

    next.summary = `${d.failedShare.toFixed(1)}% failed sessions; ${d.degradedShare.toFixed(1)}% fall back; HTTP/2 p99 ${d.h2P99.toFixed(0)}ms vs HTTP/3 p99 ${d.h3P99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `On this path HTTP/3 p99 is ${d.h3P99.toFixed(0)}ms and HTTP/2 p99 is ${d.h2P99.toFixed(0)}ms at ${d.loss.toFixed(1)}% loss and ${d.rtt.toFixed(0)}ms round-trip time.`,
    );
    items.push(
      "QUIC removes TCP head-of-line blocking between streams; it does not remove loss, congestion control, or the cost of retransmitting a lost packet.",
    );
    items.push(
      d.blockedShare > 0
        ? `${(d.blockedShare * 100).toFixed(1)}% of all sessions attempt HTTP/3 from a network that blocks UDP 443. ${d.fallback ? "They fall back to HTTP/2." : "They fail because fallback is off."}`
        : "No clients in this model are behind a UDP-blocking network.",
    );
    items.push(
      `A new QUIC handshake uses one round trip; a new TCP plus TLS 1.3 handshake uses two, an advantage of about ${d.setupAdvantage.toFixed(0)}ms on this path.`,
    );
    if (d.http3Share > 0 && d.failedShare > 0) {
      items.push("Requiring UDP for every client turns a transport optimization into an availability dependency.");
    }
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
    description: "Modest loss, most clients on HTTP/3, and a working TCP fallback for blocked networks.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher loss and round-trip time; a larger blocked population falls back to HTTP/2.",
    tone: "warn",
    params: defaults({ packetLoss: 2, rttMs: 70, http3Share: 80, udpBlockedShare: 15, fallbackEnabled: 1 }),
  },
  {
    id: "failure",
    label: "UDP blocked, no fallback",
    description: "Every client attempts HTTP/3 and 20% are behind UDP-blocking networks. Fallback is off.",
    tone: "crit",
    params: defaults({ packetLoss: 6, rttMs: 80, http3Share: 100, udpBlockedShare: 20, fallbackEnabled: 0 }),
  },
  {
    id: "h2-only",
    label: "HTTP/2 only",
    description: "The same lossy path with no HTTP/3 clients. TCP head-of-line blocking sets the tail.",
    tone: "warn",
    params: defaults({ packetLoss: 3, rttMs: 80, http3Share: 0, udpBlockedShare: 0, fallbackEnabled: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Low loss, most clients on HTTP/3, and fallback covering the few blocked networks.",
    tone: "ok",
    params: defaults({ packetLoss: 0.5, rttMs: 40, http3Share: 90, udpBlockedShare: 2, fallbackEnabled: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-udp-fallback",
  title: "Predict what happens when UDP is blocked",
  simId: "http3-quic",
  question:
    "Every client attempts HTTP/3. Twenty percent are behind a network that blocks UDP 443, and fallback is off. What happens to those sessions?",
  prediction: {
    options: [
      { id: "fail", label: "They fail; QUIC has no path over UDP, and no TCP fallback is configured." },
      { id: "h2", label: "They use HTTP/2 automatically; the browser always falls back without configuration." },
      { id: "slow-h3", label: "They use HTTP/3 more slowly because QUIC retries over UDP." },
      { id: "origin", label: "They reach the origin over TCP but the origin converts them to HTTP/3." },
    ],
    correctOptionId: "fail",
    explanation:
      "QUIC uses UDP. If UDP 443 is blocked and the client is not allowed to fall back to TCP, the transport cannot connect. A safe rollout advertises HTTP/3 as an alternative and keeps HTTP/2 over TCP as a working path. Fallback is a client and edge design decision, not a guarantee of the protocol.",
  },
  setup: defaults({ packetLoss: 6, rttMs: 80, http3Share: 100, udpBlockedShare: 20, fallbackEnabled: 0 }),
  runFor: 20,
  observe: [
    "Failed sessions hold at 20% and the client and edge nodes show failing health.",
    "The remaining 80% use HTTP/3 with p99 near 318ms on this path.",
    "HTTP/2 p99 is much higher, near 840ms, because loss stalls the TCP connection.",
    "The origin path is healthy; the failure is at the transport handshake, not in the application.",
  ],
  explain:
    "The failing population never gets a QUIC connection because UDP is blocked. HTTP/3 does not negotiate a second transport by itself; the client and edge need an alternate path such as HTTP/2 over TCP. Once fallback exists, the blocked clients become slower rather than unavailable, and the remaining clients keep the QUIC benefit. That is the correct trade for a rollout: optimize the common path, preserve the fallback.",
  fix: defaults({ packetLoss: 6, rttMs: 80, http3Share: 100, udpBlockedShare: 20, fallbackEnabled: 1 }),
  debrief:
    "With fallback on, session failures return to zero. The 20% on blocked networks now use HTTP/2 and inherit TCP head-of-line blocking; the 80% on HTTP/3 keep the lower tail. The tradeoff is that fallback hides a network problem unless you graph its share. Alert on the fallback rate, not only on failures.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "HTTP/3 is the version of HTTP that runs over QUIC, a transport protocol carried in UDP datagrams. QUIC integrates TLS 1.3 into its handshake, multiplexes independent streams over one connection, and can resume a session with 0-RTT early data. The practical difference from HTTP/2 over TCP is where loss blocks progress. TCP is one ordered byte stream: a lost segment stalls every HTTP/2 stream on that connection until the segment is retransmitted. QUIC preserves order within each stream, so a lost packet stalls the stream whose data it carried, not every other stream.",
  },
  {
    type: "p",
    text: "That does not make QUIC loss-free. All streams share the connection's congestion control, and a lost packet still costs a retransmission and a reduction in sending rate. QUIC also needs a new handshake for a new connection, just like TCP plus TLS, but it combines transport and cryptographic setup. A new QUIC handshake takes one round trip; a new TCP handshake followed by TLS 1.3 takes two. Resumption and 0-RTT can remove more, at the cost of replay risk for early data.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, network, edge or origin, application. HTTP/3 changes the client-to-edge transport; the edge still speaks HTTP semantics and may use HTTP/2 or HTTP/1.1 to the origin. A client discovers HTTP/3 through an alternative-service advertisement, then attempts QUIC on UDP 443. If UDP is blocked, the attempt fails unless the client also tries TCP. Many networks allow TCP 443 and block or rate-limit UDP, so the fallback path is part of the design, not an edge case.",
  },
  {
    type: "compare",
    leftTitle: "HTTP/2 over TCP",
    rightTitle: "HTTP/3 over QUIC",
    rows: [
      { label: "Transport", left: "TCP byte stream", right: "UDP datagrams with QUIC streams" },
      { label: "Loss scope", left: "One lost segment stalls every stream on the connection", right: "A lost packet stalls the affected stream; other streams continue" },
      { label: "New handshake", left: "TCP plus TLS 1.3, two round trips", right: "QUIC plus TLS 1.3, one round trip" },
      { label: "Network middleboxes", left: "Widely allowed on TCP 443", right: "UDP 443 may be blocked; fallback required" },
      { label: "Resumption", left: "TLS session tickets", right: "TLS resumption plus optional 0-RTT early data" },
    ],
  },
  {
    type: "p",
    text: "The simulation uses 0–10% packet loss, 20–300ms round-trip time, and an illustrative latency shape. The constants are teaching values, not protocol specifications or vendor benchmarks. The point is the direction: HTTP/3 reduces the head-of-line penalty and saves a round trip, but loss, congestion, and blocked UDP still decide the user experience.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "HTTP/2 p99 and HTTP/3 p99 side by side at the same loss and round-trip time.",
      "Failed sessions when UDP is blocked and fallback is off.",
      "Sessions falling back to HTTP/2, which preserve availability but lose the QUIC tail benefit.",
      "HTTP/3 adoption among successful sessions and the blended p99 users actually experience.",
      "A handshake advantage in milliseconds, separate from the loss penalty.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply HTTP/2 only and compare the two p99 metrics at the same loss. Apply UDP blocked, no fallback and watch session failures appear even though the origin is healthy. Turn fallback on and see failures become fallback share. Run the guided experiment before reading its explanation.",
  },
  {
    type: "table",
    headers: ["Change", "Helps", "Does not fix"],
    rows: [
      ["Enable HTTP/3", "Cross-stream head-of-line blocking, one round-trip setup", "Packet loss, congestion, blocked UDP"],
      ["Add fallback", "Availability on UDP-blocked networks", "The higher HTTP/2 latency those clients still see"],
      ["Enable 0-RTT", "One round trip on resumption", "Replay risk; it is not a general loss fix"],
      ["Reduce loss", "Both transports", "The need for a fallback when a network blocks UDP"],
    ],
  },
  { type: "sim", simId: "http3-quic" },
  { type: "experiment", experimentId: "predict-udp-fallback" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With every client on HTTP/3 and 20% behind a UDP-blocking network, those clients failed to connect. The origin was healthy and the other 80% had a lower tail than HTTP/2, but availability was decided at the transport handshake. Disabling fallback turned a network policy into a user-facing outage.",
  },
  {
    type: "p",
    text: "Enabling fallback removed the failures. The blocked clients moved to HTTP/2 and inherited TCP head-of-line blocking, so their p99 rose. The remaining clients kept the QUIC path. The model separates the two effects: HTTP/3 improves the tail under loss, while fallback protects availability when UDP is unavailable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CDN or edge: HTTP/3 request share, QUIC handshake failures, fallback share, and p99 split by protocol.",
      "Client real-user monitoring: navigation and resource timing by protocol, network type, and region.",
      "Network: UDP 443 reachability, loss, and retransmit behavior from the affected client populations.",
      "Origin: HTTP/2 request rate and latency for the fallback population; the origin may see more TCP than expected.",
      "Load balancer or proxy: QUIC listener health, connection migration events, and TLS handshake errors.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split failures by protocol and network type. If HTTP/3 attempts fail while the origin is healthy, check UDP 443 reachability and whether fallback exists. If both protocols are slow, the problem is loss or capacity, not the transport choice.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm that HTTP/3 is advertised as an alternative, not required for every client.",
      "Verify that the client retries over TCP with HTTP/2 when QUIC cannot connect.",
      "Measure fallback share by network and region; treat a rising share as a signal.",
      "Keep the HTTP/2 path sized and monitored; fallback traffic still needs capacity.",
      "Investigate UDP blocking with the network owner before disabling HTTP/3 for everyone.",
      "Test loss and round-trip time separately so the fix matches the cause.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "HTTP/3 reduces cross-stream blocking but adds UDP reachability and middlebox risk.",
      "Fallback preserves availability but can hide a growing blocked population behind normal success rates.",
      "0-RTT saves a round trip but allows replay of early data; restrict it to idempotent requests.",
      "Running both transports doubles the path surface to monitor and test.",
      "QUIC connection migration helps mobile clients change networks, but it complicates server-side connection tracking.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "compare-transports",
    question:
      "A mobile user sees 4-second page loads on a lossy network. How do you decide whether HTTP/3 will help?",
    difficulty: 3,
    hints: [
      "Separate loss from round-trip time.",
      "Look for head-of-line blocking across streams.",
    ],
    answer:
      "I would measure loss, round-trip time, retransmits, and p99 by protocol and network type. If the tail is dominated by one lost TCP segment stalling many streams, HTTP/3 can help because QUIC scopes loss to the affected stream. If the tail is dominated by distance or a slow origin, HTTP/3 saves at most a handshake round trip and will not fix it. I would also check whether the user's network allows UDP 443 and whether fallback works, because a protocol change that fails to connect is worse than the slower path.",
    followUps: [
      "What would you measure before and after the change?",
      "How does 0-RTT change the comparison?",
      "When would you keep HTTP/2 only?",
    ],
    redFlags: [
      "Says HTTP/3 eliminates packet loss.",
      "Ignores UDP blocking.",
      "Uses average latency instead of the tail.",
    ],
    rubric: [
      "Separates loss from RTT.",
      "Names head-of-line blocking.",
      "Checks fallback.",
      "Defines a measurement.",
    ],
  },
  {
    id: "fallback-design",
    question:
      "How do you roll out HTTP/3 without making UDP reachability an availability requirement?",
    difficulty: 3,
    hints: [
      "HTTP/3 should be an alternative, not a hard requirement.",
      "Measure the population that cannot use it.",
    ],
    answer:
      "I would advertise HTTP/3 through an alternative-service mechanism and keep HTTP/2 over TCP as the default path. Clients that cannot establish QUIC must retry over TCP, and the edge must keep both listeners healthy. I would graph HTTP/3 share, fallback share, and failures by network type, then canary the rollout by region or client cohort. The critical check is that a UDP-blocked client still completes the request, even if it is slower.",
    followUps: [
      "What does the fallback share tell you that failure rate does not?",
      "How would you canary the change?",
      "What would make you roll back?",
    ],
    redFlags: [
      "Redirects all traffic to HTTP/3.",
      "Treats fallback as an error.",
      "Does not measure blocked networks.",
    ],
    rubric: [
      "Keeps HTTP/2 available.",
      "Names fallback and measurement.",
      "Canaries by cohort.",
      "Defines rollback.",
    ],
  },
  {
    id: "hol-scope",
    question:
      "Does QUIC remove head-of-line blocking entirely? Explain what is and is not removed.",
    difficulty: 4,
    hints: [
      "Streams are independent, but the connection shares congestion control.",
      "A lost packet belongs to a stream.",
    ],
    answer:
      "QUIC removes transport-level head-of-line blocking between streams: a lost packet for one stream does not stop delivery of other streams. It does not remove loss or congestion control. The stream whose data was lost still waits for retransmission, and the connection's sending rate can drop, so a burst of loss can slow every stream. TCP instead has one ordered byte stream, so a lost segment blocks all HTTP/2 streams until it is recovered. The distinction is the scope of the stall, not the absence of one.",
    followUps: [
      "How would you detect per-stream stalls?",
      "Why can a loss still reduce throughput for all streams?",
      "What does 0-RTT have to do with head-of-line blocking?",
    ],
    redFlags: [
      "Says QUIC has no head-of-line blocking at all.",
      "Confuses loss recovery with ordering.",
      "Ignores congestion control.",
    ],
    rubric: [
      "Scopes HOL to streams.",
      "Keeps loss and congestion.",
      "Contrasts with TCP ordering.",
      "Mentions per-stream stalls.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "HTTP/3 is advertised as an alternative, with HTTP/2 over TCP still available.",
      "UDP 443 reachability and fallback share are measured by network type.",
      "Dashboards split p99 by protocol, not just by route.",
      "0-RTT is limited to idempotent requests and its replay risk is accepted explicitly.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate handshake failures from slow requests.",
      "Check whether failed clients are on UDP-blocking networks.",
      "Compare HTTP/2 and HTTP/3 p99 for the same population.",
      "Check loss and retransmits before changing transport settings.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify fallback works for the blocked population, not only in a lab.",
      "Re-measure p99 and failure rate by protocol after the change.",
      "Document the fallback share as an availability signal.",
      "Review whether HTTP/3 is still an optimization rather than a requirement.",
    ],
  },
];

const references = [
  {
    title: "RFC 9000: QUIC: A UDP-Based Multiplexed and Secure Transport",
    url: "https://www.rfc-editor.org/rfc/rfc9000",
    publisher: "IETF",
    kind: "standard" as const,
    note: "QUIC streams, packet loss recovery, connection establishment, and migration.",
  },
  {
    title: "HTTP/3",
    url: "https://developers.cloudflare.com/speed/optimization/protocol/http3/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "HTTP/3 rollout behavior, UDP reachability, and fallback guidance.",
  },
  {
    title: "RFC 9114: HTTP/3",
    url: "https://www.rfc-editor.org/rfc/rfc9114",
    publisher: "IETF",
    kind: "standard" as const,
    note: "HTTP semantics over QUIC and the HTTP/3 framing layer.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "http3-quic": {
      model: http3Model,
      presets,
      instructions:
        "Start healthy, then apply HTTP/2 only and compare the two p99 metrics. Apply UDP blocked, no fallback and watch session failures. Turn fallback on and see failures become a slower fallback population.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Loss and latency constants are teaching values, not protocol specifications or vendor benchmarks. The model assumes all HTTP/3 clients discover it the same way.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-tls-termination", "traffic-keepalive-idle-timeout", "traffic-grpc-lb"],
};
