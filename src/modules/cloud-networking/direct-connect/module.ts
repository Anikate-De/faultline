import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DX_PATH_GBPS = 10;
const VPN_CAPACITY_GBPS = 1;
const DX_LATENCY_MS = 4;
const VPN_LATENCY_MS = 22;

const params = [
  {
    id: "trafficGbps",
    label: "Offered traffic",
    min: 1,
    max: 20,
    step: 0.5,
    value: 6,
    unit: " Gbps",
    group: "Traffic",
    help: "Traffic from the office to the VPC. Illustrative values keep the arithmetic readable; real office links vary by orders of magnitude.",
    format: "number" as const,
  },
  {
    id: "dxPaths",
    label: "Direct Connect paths",
    min: 1,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "1 is one connection at one Direct Connect location. 2 is two connections at two locations, which separates the locations' failure domains.",
    format: "count" as const,
  },
  {
    id: "dxOutage",
    label: "Direct Connect outage",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 fails one Direct Connect location. With one path, all dedicated capacity is gone. With two paths, the other location should carry traffic if BGP converges.",
    format: "count" as const,
  },
  {
    id: "vpnReady",
    label: "VPN backup ready",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Backup",
    help: "1 means a site-to-site VPN is configured with a route that can be selected. A tunnel can be up and still not be selected by BGP.",
    format: "count" as const,
  },
  {
    id: "fastWithdraw",
    label: "Fast BGP withdrawal",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failover",
    help: "1 models Bidirectional Forwarding Detection (BFD) or short BGP timers withdrawing the failed prefix in seconds. 0 leaves the default hold timer in charge.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  offered: number;
  dxPaths: number;
  outage: boolean;
  vpnReady: boolean;
  fastWithdraw: boolean;
  liveDxPaths: number;
  stale: boolean;
  dxCarried: number;
  vpnCarried: number;
  delivered: number;
  availability: number;
  failoverSeconds: number;
  latency: number;
  dxUtilization: number;
  officeHealth: Health;
  dxHealth: Health;
  vpnHealth: Health;
  routeHealth: Health;
  appHealth: Health;
  mode: string;
}

function compute(p: Params): Computed {
  const offered = Math.max(0.1, num(p, "trafficGbps", 6));
  const dxPaths = Math.max(1, Math.min(2, Math.round(num(p, "dxPaths", 2))));
  const outage = num(p, "dxOutage", 0) >= 0.5;
  const vpnReady = num(p, "vpnReady", 1) >= 0.5;
  const fastWithdraw = num(p, "fastWithdraw", 1) >= 0.5;
  const liveDxPaths = outage ? Math.max(0, dxPaths - 1) : dxPaths;
  const stale = outage && !fastWithdraw;
  let dxCarried: number;
  let vpnCarried = 0;
  if (!stale) {
    dxCarried = Math.min(offered, liveDxPaths * DX_PATH_GBPS);
    if (liveDxPaths === 0) {
      vpnCarried = vpnReady ? Math.min(offered, VPN_CAPACITY_GBPS) : 0;
    } else if (outage) {
      vpnCarried = vpnReady ? Math.min(offered - dxCarried, VPN_CAPACITY_GBPS) : 0;
    }
  } else {
    const failedShare = offered / dxPaths;
    const liveShare = offered - failedShare;
    dxCarried = Math.min(liveShare, liveDxPaths * DX_PATH_GBPS);
  }
  const delivered = dxCarried + vpnCarried;
  const availability = offered > 0 ? clamp((delivered / offered) * 100, 0, 100) : 0;
  const failoverSeconds = !outage ? 0 : fastWithdraw ? 20 : 90;
  const latency =
    delivered > 0
      ? (dxCarried * DX_LATENCY_MS + vpnCarried * VPN_LATENCY_MS) / delivered
      : DX_LATENCY_MS;
  const dxUtilization = liveDxPaths > 0 ? clamp(dxCarried / (liveDxPaths * DX_PATH_GBPS), 0, 1) : 0;
  const officeHealth: Health = availability >= 99.9 ? "ok" : availability >= 99 ? "warn" : "crit";
  const dxHealth: Health = outage
    ? "down"
    : dxUtilization >= 0.95
      ? "crit"
      : dxUtilization >= 0.8
        ? "warn"
        : "ok";
  const vpnHealth: Health = vpnReady ? "ok" : outage ? "crit" : "warn";
  const routeHealth: Health = stale || (outage && liveDxPaths === 0 && !vpnReady) ? "crit" : "ok";
  const appHealth: Health = delivered >= offered ? "ok" : delivered > 0 ? "warn" : "crit";
  const mode = !outage
    ? "primary path"
    : stale
      ? "stale DX route"
      : delivered > 0
        ? vpnCarried > 0
          ? "DX plus VPN"
          : "remaining DX path"
        : "no path";
  return {
    offered,
    dxPaths,
    outage,
    vpnReady,
    fastWithdraw,
    liveDxPaths,
    stale,
    dxCarried,
    vpnCarried,
    delivered,
    availability,
    failoverSeconds,
    latency,
    dxUtilization,
    officeHealth,
    dxHealth,
    vpnHealth,
    routeHealth,
    appHealth,
    mode,
  };
}

function gbps(value: number): string {
  return `${value.toFixed(1)} Gbps`;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 5)) / 2.5));
      return item.format === "percent" || item.id === "availability"
        ? clamp(wave, 0, 100)
        : Math.max(0, wave);
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const pathLabel = `${v.dxPaths} path${v.dxPaths === 1 ? "" : "s"} · ${v.dxPaths * DX_PATH_GBPS} Gbps`;
  return {
    t: 0,
    nodes: [
      {
        id: "office",
        label: "office network",
        kind: "client",
        health: v.officeHealth,
        sublabel: `${gbps(v.offered)} offered`,
        detail: `The office sends ${gbps(v.offered)} toward the VPC. It can use a Direct Connect path, a VPN path, or both, depending on the routes it receives.`,
        meta: { view: "flow" },
      },
      {
        id: "dx",
        label: "Direct Connect",
        kind: "external",
        health: v.dxHealth,
        utilization: v.dxUtilization,
        sublabel: pathLabel,
        detail: `Illustrative capacity of ${DX_PATH_GBPS} Gbps per path. Direct Connect is private and dedicated, but the two connections are diverse only when they terminate at different locations and provider devices.`,
        meta: { view: "flow", mode: v.mode },
      },
      {
        id: "vpn",
        label: "VPN backup",
        kind: "external",
        health: v.vpnHealth,
        sublabel: v.vpnReady ? `standby · ${VPN_CAPACITY_GBPS} Gbps` : "not configured",
        detail: v.vpnReady
          ? `The VPN runs over the internet with an illustrative ceiling of ${VPN_CAPACITY_GBPS} Gbps. It only carries traffic when a route selects it and the security policy permits it.`
          : "No backup tunnel is configured. A Direct Connect outage then has no alternate path, even if the office has internet access.",
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "BGP and route table",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: v.stale ? "stale prefix still best" : "converged",
        detail: v.stale
          ? "The Direct Connect prefix remains in the routing table because the BGP session has not withdrawn it. Local preference keeps it ahead of the VPN prefix, so traffic still enters the failed path."
          : "The routing table selects a usable path. Failover time depends on how quickly the failed prefix is withdrawn and the backup is installed.",
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "VPC workloads",
        kind: "service",
        health: v.appHealth,
        sublabel: `${gbps(v.delivered)} delivered`,
        detail: `Applications receive ${gbps(v.delivered)} of ${gbps(v.offered)}. The path label is ${v.mode}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("office-dx", "office", "dx", v.offered > 0 ? v.dxCarried / v.offered : 0, v.dxHealth),
      edge(
        "office-vpn",
        "office",
        "vpn",
        v.offered > 0 ? v.vpnCarried / v.offered : 0,
        v.stale ? "warn" : v.vpnHealth,
      ),
      edge("dx-route", "dx", "route", v.offered > 0 ? v.dxCarried / v.offered : 0, v.routeHealth),
      edge("route-app", "route", "app", v.offered > 0 ? v.delivered / v.offered : 0, v.appHealth),
    ],
    metrics: [
      metric("unavailable", "Path unavailability", 100 - v.availability, "%", 0.1, 1, "percent"),
      metric(
        "delivered-gbps",
        "Delivered traffic",
        v.delivered,
        " Gbps",
        undefined,
        undefined,
        "number",
      ),
      metric("failover-time", "Failover time", v.failoverSeconds, " s", 30, 120, "number"),
      metric("path-latency", "Selected path latency", v.latency, " ms", 10, 30, "ms"),
      metric(
        "dx-utilization",
        "Direct Connect utilization",
        v.dxUtilization * 100,
        "%",
        80,
        95,
        "percent",
      ),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${gbps(v.offered)} offered; ${gbps(v.delivered)} delivered; ${v.mode}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unavailable",
    metricId: "unavailable",
    warn: 0.1,
    crit: 1,
    title: "Traffic is not reaching the VPC",
    cause:
      "The selected Direct Connect path is stale, the backup is missing, or the surviving path cannot carry the offered load. Connection and tunnel state do not prove delivery.",
    fix: "Restore a usable path, withdraw any stale prefix, and size the backup for the load it must protect.",
    checkFirst: [
      "Read the BGP state for the Direct Connect virtual interface, not only the connection state.",
      "Check which prefix the route table selects and its next hop.",
      "Confirm the VPN tunnel is up and its route is installed and preferred.",
    ],
  },
  {
    id: "failover-time",
    metricId: "failover-time",
    warn: 30,
    crit: 120,
    title: "Failover is waiting on a slow control-plane signal",
    cause:
      "Without fast failure detection, BGP keeps the failed prefix until the hold timer expires. The data plane is already broken, so every second of delay is dropped traffic.",
    fix: "Enable BFD or tune BGP timers within provider guidance, and test that the backup is selected after a real path failure rather than only after a session reset.",
    checkFirst: [
      "Check whether BFD is enabled on the virtual interface.",
      "Compare the BGP hold timer with the recovery objective.",
      "Verify the backup route exists before the failure.",
    ],
  },
  {
    id: "dx-utilization",
    metricId: "dx-utilization",
    warn: 80,
    crit: 95,
    title: "The surviving Direct Connect path is near its ceiling",
    cause:
      "After losing one location, the remaining path carries traffic that was sized for two. Utilisation rises even when availability still looks acceptable.",
    fix: "Shift non-critical traffic to the VPN, reduce load, or add diverse capacity. A backup tunnel that is smaller than the protected load changes the failure into a capacity incident.",
    checkFirst: [
      "Compare offered traffic with the surviving path capacity.",
      "Check whether the backup VPN can carry the overflow.",
      "Confirm the remaining path is healthy and not sharing the failed location's provider.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const directConnectModel: SimModel = {
  id: "cloud-networking-direct-connect",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [];
    const jitter = rng.between(-0.3, 0.3);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "delivered-gbps" && values.delivered > 0) {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      if (item.id === "path-latency" && values.delivered > 0) {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.stale && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "stale-dx-route",
        severity: "crit",
        title: values.vpnReady ? "VPN backup is up but unused" : "Stale Direct Connect route",
        detail: values.vpnReady
          ? "The Direct Connect prefix is still selected after the path failed. The VPN has a route, but BGP local preference keeps the stale prefix ahead of it, so the failed share is dropped."
          : "The Direct Connect prefix is still selected after the path failed, and no VPN backup is ready. The failed share is dropped until the prefix is withdrawn.",
        nodeId: "route",
        metricId: "unavailable",
      });
    }
    next.flags.staleLogged = values.stale ? 1 : 0;
    if (values.outage && !values.vpnReady && frame.flags.noBackupLogged !== 1) {
      pushEvent(next, {
        id: "no-backup-path",
        severity: "crit",
        title: "No backup path configured",
        detail:
          "The Direct Connect location failed and no VPN is ready to take over. A dedicated link is not a redundant link unless a second diverse path exists.",
        nodeId: "vpn",
        metricId: "unavailable",
      });
    }
    next.flags.noBackupLogged = values.outage && !values.vpnReady ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `${gbps(values.offered)} offered; ${gbps(values.delivered)} delivered; ${values.mode}.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.stale) {
      items.push(
        `The Direct Connect path is down, but its prefix is still selected. ${gbps(v.offered - v.delivered)} of ${gbps(v.offered)} is dropped while the VPN reports up.`,
      );
    } else if (v.outage && v.vpnCarried > 0) {
      items.push(
        `Failover completed, but the VPN ceiling is ${VPN_CAPACITY_GBPS} Gbps. ${gbps(v.offered - v.delivered)} has no path because the backup was not sized for the protected load.`,
      );
    } else if (v.outage && v.dxCarried > 0) {
      items.push(
        `The surviving Direct Connect path carries ${gbps(v.dxCarried)}. Diversity kept one location alive; it did not double the capacity of the failed one.`,
      );
    } else {
      items.push(
        `The primary path carries ${gbps(v.delivered)} at ${(v.dxUtilization * 100).toFixed(0)}% utilization. There is no outage, so no failover is in progress.`,
      );
    }
    items.push(
      "A BGP session can stay up while the data plane is broken. Until the prefix is withdrawn, attributes such as local preference keep sending traffic to a path that cannot deliver it.",
    );
    items.push(
      "Two connections that share one Direct Connect location share power, cooling, and provider equipment. Diversity is a property of the whole path, not the cable count.",
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
    description: "Two diverse Direct Connect paths carry 6 Gbps; the VPN is standing by.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "18 Gbps runs over two 10 Gbps paths. Both paths are near 90% utilization.",
    tone: "warn",
    params: defaults({ trafficGbps: 18 }),
  },
  {
    id: "failure",
    label: "Stale DX route",
    description:
      "One location fails and the BGP hold timer keeps the dead path selected. The VPN is up but unused.",
    tone: "crit",
    params: defaults({ trafficGbps: 12, dxOutage: 1, vpnReady: 1, fastWithdraw: 0 }),
  },
  {
    id: "backup",
    label: "VPN takes over",
    description: "Fast withdrawal works, but the 1 Gbps VPN cannot absorb a 12 Gbps load.",
    tone: "crit",
    params: defaults({ trafficGbps: 12, dxOutage: 1, vpnReady: 1, fastWithdraw: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The failed location returns and both Direct Connect paths carry traffic again.",
    tone: "ok",
    params: defaults({ trafficGbps: 6, dxOutage: 0, vpnReady: 1, fastWithdraw: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-dx-route",
  title: "Predict what the backup does",
  simId: "hybrid-path",
  question:
    "A Direct Connect location fails. Its BGP session has not yet expired the hold timer, so the prefix is still advertised. The VPN is up with a valid route. What happens during the next 30 seconds?",
  prediction: {
    options: [
      { id: "vpn-takes-over", label: "The VPN is selected immediately because its tunnel is up." },
      {
        id: "stale-drop",
        label: "The stale Direct Connect route stays selected and the failed share is dropped.",
      },
      { id: "ecmp", label: "BGP load-balances evenly across Direct Connect and the VPN." },
      {
        id: "dx-reroutes",
        label: "Direct Connect reroutes the prefix to the other location automatically.",
      },
    ],
    correctOptionId: "stale-drop",
    explanation:
      "A tunnel being up is not the same as a route being selected. Until the Direct Connect prefix is withdrawn or its attributes change, the route table keeps preferring it. The data plane is already broken, so the traffic that follows that path is dropped. BFD or shorter timers shorten the window; they do not make the VPN preferred on their own.",
  },
  setup: defaults({ trafficGbps: 12, dxOutage: 1, vpnReady: 1, fastWithdraw: 0 }),
  runFor: 30,
  observe: [
    "Path unavailability is 50% while the VPN node reports up.",
    "Failover time is 90 seconds, the default BGP hold-time bound, because the failed prefix is still selected.",
    "Delivered traffic is 6 Gbps: the failed location's share is dropped, and the live location carries the rest.",
    "The route node is critical while the Direct Connect node is down.",
    "The VPN carries no traffic even though it has capacity.",
  ],
  explain:
    "BGP withdraws a prefix when the session goes down or the peer withdraws it. A data-plane failure can precede both. The default hold timer is 90 seconds, and route selection still prefers the old path during that window. Fast failure detection is a separate control from having a backup path.",
  fix: defaults({ trafficGbps: 7, dxOutage: 1, vpnReady: 1, fastWithdraw: 1 }),
  debrief:
    "With fast withdrawal, the dead prefix leaves the table and the surviving Direct Connect path carries 7 Gbps with headroom. The VPN was not needed at this load. At 12 Gbps, the backup would cap delivery at 11 Gbps and turn the incident into a capacity problem.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Direct Connect is a private connection between your network and AWS. You contract a connection at a Direct Connect location, and the provider crosses it to an AWS router. A virtual interface (VIF) carries BGP (Border Gateway Protocol) peering: a private VIF connects to a virtual private gateway, and a transit VIF connects to a Direct Connect gateway and then to a transit gateway or VPC.",
  },
  {
    type: "p",
    text: "The service is dedicated and private, but it is not automatically redundant. A single connection has one location, one provider handoff, and one set of equipment. Two connections in the same location share most of those failure domains. Resilient designs use two locations, separate provider devices, and often a VPN as a third path.",
  },
  {
    type: "p",
    text: "BGP is the control plane that advertises prefixes and selects a path. It is not a health check for the data plane. A session can remain established while packets are dropped, and the route stays selected until the prefix is withdrawn or a better path wins.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is office router, provider network, Direct Connect location, AWS router, virtual interface, gateway, VPC route table, workload. The return path is a separate route. The VPN backup follows the same logical shape over the internet, but its tunnel, route, and security policy are independent.",
  },
  {
    type: "compare",
    leftTitle: "One location, two connections",
    rightTitle: "Two locations, two connections",
    rows: [
      { label: "Power and cooling", left: "Shared", right: "Independent" },
      { label: "Provider equipment", left: "Often shared", right: "Separate handoffs" },
      { label: "Single outage blast radius", left: "Both paths", right: "One path" },
      {
        label: "Failover test",
        left: "Can look redundant and fail together",
        right: "Exercises a real location loss",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Path unavailability: the share of offered traffic that does not reach the VPC.",
      "Delivered traffic in Gbps: what actually crosses the selected paths.",
      "Failover time: how long the route table keeps using a failed path.",
      "Selected path latency: Direct Connect is stable and short; the VPN adds internet variance.",
      "Direct Connect utilization: the surviving path can become the next bottleneck.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that the VPN is up but idle. Apply Stale DX route and watch path unavailability, failover time, and the route node. The VPN never enters the path because the old prefix is still preferred. Then run VPN takes over to see the capacity ceiling, and finally Recovery. Change one slider at a time and read the causal panel before moving on.",
  },
  {
    type: "p",
    text: "The model uses 10 Gbps per Direct Connect path and 1 Gbps for the VPN. These are illustrative teaching values, not service limits or a sizing recommendation. Latency, hold timers, and convergence times are also simplified.",
  },
  { type: "sim", simId: "hybrid-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With one location down and no fast withdrawal, the old Direct Connect prefix stayed in the route table. Half of the offered traffic followed the dead path and was dropped. The VPN was up, had capacity, and still carried nothing. Tunnel state and path selection are different facts.",
  },
  {
    type: "p",
    text: "Fast withdrawal changed the control plane, not the capacity. The surviving Direct Connect path took the load, which worked at 10 Gbps and failed at 12 Gbps. The VPN then carried 1 Gbps of overflow, leaving 1 Gbps with no path. A backup that is smaller than the protected load converts an availability incident into a capacity incident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Direct Connect console: connection state, virtual interface state, and BGP session state for each VIF.",
      "BGP: received and advertised prefixes, local preference, AS path, and whether the failed prefix is still present.",
      "Route tables: the winning route and its target. A route can point at a virtual interface whose data plane is not forwarding.",
      "VPN: both tunnels, their state, and the routes they install. One tunnel up is not a working backup.",
      "CloudWatch: Direct Connect connection and virtual interface metrics, plus flow logs or traffic mirroring where available.",
      "Change history: provider maintenance, router upgrades, and BGP timer changes are common triggers.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the BGP prefix and the winning route before touching the VPN. If the failed Direct Connect prefix is still selected, the backup has nothing to do. Then confirm the VPN route is installed and that the security policy permits the traffic. Capacity is the third question, not the first.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the failed path and the prefix it still advertises. Record the route target and the BGP session state.",
      "Withdraw the stale prefix or let the session expire. Prefer a controlled change over clearing a session you do not own.",
      "Confirm the backup route is installed and selected, then verify the tunnel and security policy with real traffic.",
      "If failover is slow, enable BFD or tune timers within the provider's supported values and test it.",
      "Check the surviving path's utilization and the backup's capacity against the protected load.",
      "Restore diversity, not just the failed connection. Confirm the two paths no longer share a location or provider device.",
      "Write down the observed failover time and update the runbook with the exact commands or console checks.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Two diverse Direct Connect locations cost more than two connections in one location, but they remove a shared failure domain. The cheaper pair can fail together.",
      "A VPN backup is quick to add and cheap relative to dedicated capacity, but it runs over the internet and is usually much smaller. Decide what load it must protect.",
      "Fast BGP timers and BFD reduce outage time but can flap on a marginal link. Test them against the provider's guidance.",
      "Keeping the primary path preferred is correct while it works. The risk is that preference survives a data-plane failure, so failure detection must be independent.",
      "Restoring the old path is usually fastest. It can also restore the shared dependency that failed, so verify diversity before declaring recovery.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "dx-not-diverse",
    question:
      "A team has two Direct Connect connections and calls the design redundant. What do you ask before agreeing?",
    difficulty: 3,
    hints: [
      "Diversity is about failure domains, not cable count.",
      "Ask where each connection terminates.",
    ],
    answer:
      "I would ask whether the connections terminate at different Direct Connect locations, whether they use different provider devices and handoffs, and whether the on-premises routers and power feeds are independent. Two connections at one location share power, cooling, and much of the provider equipment, so a location outage takes both. I would also check the logical side: separate virtual interfaces, diverse gateways where required, and BGP attributes that actually allow one path to take over. Then I would test a real location failure, not just a single cable.",
    followUps: [
      "How would you prove the paths are diverse?",
      "What does a transit VIF change?",
      "When is a VPN the right third path?",
    ],
    redFlags: [
      "Counts links and calls it redundancy.",
      "Ignores the on-premises side.",
      "Assumes AWS handles failover automatically.",
    ],
    rubric: [
      "Names location and provider diversity.",
      "Checks logical path independence.",
      "Tests a realistic failure.",
      "Considers the on-premises failure domains.",
    ],
  },
  {
    id: "vpn-up-no-traffic",
    question:
      "The VPN tunnels show up, but no traffic uses them after a Direct Connect failure. What is your sequence?",
    difficulty: 3,
    hints: [
      "Start with the route that is winning, not the tunnel.",
      "A stale prefix can outlive the data plane.",
    ],
    answer:
      "I would first read the route table and BGP table to see whether the Direct Connect prefix is still present and preferred. If it is, the VPN is healthy but irrelevant. I would check the BGP session and hold timer, then withdraw the stale prefix or use fast failure detection. Next I would confirm the VPN route is installed, the tunnel is up, and the security policy allows the traffic. Finally I would test with real traffic and check capacity, because a working backup can still be too small.",
    followUps: [
      "Which signal tells you the prefix is stale?",
      "Why can the tunnel be up with no route?",
      "What would you automate?",
    ],
    redFlags: [
      "Restarts the VPN first.",
      "Assumes BGP withdraws immediately.",
      "Skips the security policy.",
    ],
    rubric: [
      "Checks the winning route first.",
      "Explains stale prefixes and hold timers.",
      "Verifies the backup route and policy.",
      "Tests capacity and real traffic.",
    ],
  },
  {
    id: "failover-test",
    question: "How do you test hybrid failover without causing a production outage?",
    difficulty: 3,
    hints: [
      "Test the failure mode, not only the configuration.",
      "A maintenance window is not the same as a real path failure.",
    ],
    answer:
      "I would build a test path with the same routing and policy shape, then fail one component at a time: shut a virtual interface, withdraw a prefix, expire a session, and block the backup tunnel. I would measure how long the route table takes to select the backup, whether the backup carries the protected load, and whether the return path works. For production, I would use provider maintenance windows, BFD or controlled route changes, and a rollback plan. A configuration review proves intent; only a failure test proves behavior.",
    followUps: [
      "What would you measure during the test?",
      "How do you test the return path?",
      "What is the rollback if the backup fails?",
    ],
    redFlags: [
      "Only reviews configuration.",
      "Tests by rebooting a production router.",
      "Forgets the return path.",
    ],
    rubric: [
      "Tests individual failure modes.",
      "Measures convergence and capacity.",
      "Checks both directions.",
      "Has a rollback and a maintenance plan.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each Direct Connect path has a named location, provider handoff, and owner.",
      "Diversity is documented at the location, device, and on-premises router level.",
      "BGP hold timers and BFD settings match the recovery objective.",
      "The VPN backup is tested with the load it must protect, not only with a ping.",
      "Alerts cover BGP prefix presence and route selection, not only connection state.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the BGP table and the winning route before changing the backup.",
      "Confirm whether the failed prefix is still advertised or selected.",
      "Check the VPN tunnel, route, and security policy in that order.",
      "Measure the surviving path's utilization and the backup's capacity.",
      "Record the time from failure to first delivered packet.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore diversity and verify the paths do not share the failed dependency.",
      "Re-test failover with the same load and record the result.",
      "Update capacity assumptions for the surviving path and the backup.",
      "Add a check for stale prefixes and slow withdrawal.",
    ],
  },
];

const references = [
  {
    title: "What is AWS Direct Connect?",
    url: "https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connections, virtual interfaces, gateways, and the private path from on-premises to AWS.",
  },
  {
    title: "Direct Connect resiliency recommendations",
    url: "https://docs.aws.amazon.com/directconnect/latest/UserGuide/resiliency_toolkit.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The resiliency toolkit and the difference between connections that share a location and connections that do not.",
  },
  {
    title: "Direct Connect routing and BGP",
    url: "https://docs.aws.amazon.com/directconnect/latest/UserGuide/routing-and-bgp.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "BGP sessions, route advertisement, and failure detection on virtual interfaces.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hybrid-path": {
      model: directConnectModel,
      presets,
      instructions:
        "Start Healthy, then compare the stale-route failure with fast withdrawal. Watch the winning route and the VPN together, then check capacity in the backup preset.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Direct Connect capacity is 10 Gbps per path and the VPN ceiling is 1 Gbps; these are teaching values, not service limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpn",
    "cloud-networking-bgp",
    "cloud-networking-route-tables",
    "cloud-networking-cross-az-region",
  ],
};
