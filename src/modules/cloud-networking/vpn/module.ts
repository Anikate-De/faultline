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

const TUNNEL_CAPACITY_MBPS = 1250;
const TUNNEL_LATENCY_MS = 18;

const params = [
  {
    id: "tunnelsUp",
    label: "Tunnels up",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Tunnel",
    help: "How many of the two VPN tunnels are established. Tunnel 1 comes up first; tunnel 2 is the second. A tunnel can be up and still not be selected by a route.",
    format: "count" as const,
  },
  {
    id: "routeTarget",
    label: "Route target",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Routing",
    help: "0 means no matching route, 1 selects tunnel 1, 2 selects tunnel 2. This is a teaching abstraction for the gateway or customer-router decision; a VPC route table points at the VPN attachment, not at a tunnel.",
    format: "count" as const,
  },
  {
    id: "securityPolicy",
    label: "Security policy allows traffic",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "1 allows the on-premises prefixes through the tunnel and the VPC security groups. 0 blocks the traffic after the tunnel and route are already correct.",
    format: "count" as const,
  },
  {
    id: "trafficMbps",
    label: "Offered traffic",
    min: 100,
    max: 1200,
    step: 50,
    value: 400,
    unit: " Mbps",
    group: "Traffic",
    help: "Traffic that needs to cross the VPN. The tunnel ceiling in this model is 1,250 Mbps, an illustrative value near the upper end of a VPN tunnel.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tunnelsUp: number;
  routeTarget: number;
  policy: boolean;
  offered: number;
  tunnel1Up: boolean;
  tunnel2Up: boolean;
  selectedTunnel: number;
  selectedUp: boolean;
  delivered: number;
  dropRate: number;
  utilization: number;
  latency: number;
  mode: string;
  officeHealth: Health;
  tunnel1Health: Health;
  tunnel2Health: Health;
  routeHealth: Health;
  policyHealth: Health;
  appHealth: Health;
}

function compute(p: Params): Computed {
  const tunnelsUp = Math.max(0, Math.min(2, Math.round(num(p, "tunnelsUp", 2))));
  const routeTarget = Math.max(0, Math.min(2, Math.round(num(p, "routeTarget", 1))));
  const policy = num(p, "securityPolicy", 1) >= 0.5;
  const offered = Math.max(1, num(p, "trafficMbps", 400));
  const tunnel1Up = tunnelsUp >= 1;
  const tunnel2Up = tunnelsUp >= 2;
  const selectedTunnel = routeTarget;
  const selectedUp = routeTarget === 1 ? tunnel1Up : routeTarget === 2 ? tunnel2Up : false;
  const delivered = selectedUp && policy ? Math.min(offered, TUNNEL_CAPACITY_MBPS) : 0;
  const dropRate = clamp(100 - (delivered / offered) * 100, 0, 100);
  const utilization = clamp((delivered / TUNNEL_CAPACITY_MBPS) * 100, 0, 100);
  const mode = !selectedUp
    ? routeTarget === 0
      ? "no route"
      : `route points to down tunnel ${routeTarget}`
    : !policy
      ? "policy blocked"
      : delivered < offered
        ? "tunnel saturated"
        : "forwarding";
  const officeHealth: Health = dropRate === 0 ? "ok" : dropRate < 100 ? "warn" : "crit";
  const routeHealth: Health = selectedUp ? "ok" : "crit";
  const policyHealth: Health = policy ? "ok" : "crit";
  const appHealth: Health = delivered >= offered ? "ok" : delivered > 0 ? "warn" : "crit";
  return {
    tunnelsUp,
    routeTarget,
    policy,
    offered,
    tunnel1Up,
    tunnel2Up,
    selectedTunnel,
    selectedUp,
    delivered,
    dropRate,
    utilization,
    latency: delivered > 0 ? TUNNEL_LATENCY_MS : 0,
    mode,
    officeHealth,
    tunnel1Health: tunnel1Up ? "ok" : "down",
    tunnel2Health: tunnel2Up ? "ok" : "down",
    routeHealth,
    policyHealth,
    appHealth,
  };
}

function mbps(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} Mbps`;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 6)) / 2.4));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "office",
        label: "on-premises network",
        kind: "client",
        health: v.officeHealth,
        sublabel: `${mbps(v.offered)} to send`,
        detail: `The on-premises network sends ${mbps(v.offered)} to the VPC. It needs a route, a live tunnel, and a policy that permits the flow.`,
        meta: { view: "flow" },
      },
      {
        id: "tunnel1",
        label: "tunnel 1",
        kind: "external",
        health: v.tunnel1Health,
        sublabel: v.tunnel1Up ? "established" : "down",
        detail: v.tunnel1Up
          ? "Tunnel 1 has an established Internet Key Exchange (IKE) and IPsec security association. It is a candidate path, not necessarily the selected path."
          : "Tunnel 1 is down. A route that still points at it drops traffic until the route is changed or BGP withdraws the path.",
        meta: { view: "flow" },
      },
      {
        id: "tunnel2",
        label: "tunnel 2",
        kind: "external",
        health: v.tunnel2Health,
        sublabel: v.tunnel2Up ? "established" : "down",
        detail: v.tunnel2Up
          ? "Tunnel 2 is the second path. AWS creates two tunnels per site-to-site connection so one can fail without losing the connection."
          : "Tunnel 2 is down. A static route or a BGP advertisement may still prefer it unless failover is configured and tested.",
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "VPN routing",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: v.routeTarget === 0 ? "no match" : `selects tunnel ${v.routeTarget}`,
        detail: v.selectedUp
          ? `The gateway or customer-router decision selects tunnel ${v.routeTarget}, which is up. The tunnel ceiling is ${mbps(TUNNEL_CAPACITY_MBPS)} in this model.`
          : `The gateway or customer-router decision selects tunnel ${v.routeTarget}, which is not up. Nothing else uses the healthy tunnel automatically under static routing.`,
        meta: { view: "flow" },
      },
      {
        id: "policy",
        label: "security policy",
        kind: "mesh",
        health: v.policyHealth,
        sublabel: v.policy ? "permit" : "deny",
        detail: v.policy
          ? "Security groups, network ACLs, and the tunnel's traffic selectors allow the on-premises prefixes."
          : "The tunnel and route are correct, but the security policy or traffic selector blocks the flow. This looks like a dead tunnel from the application.",
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "VPC workload",
        kind: "service",
        health: v.appHealth,
        sublabel: `${mbps(v.delivered)} delivered`,
        detail: `The workload receives ${mbps(v.delivered)} of ${mbps(v.offered)}. The path state is ${v.mode}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("office-tunnel1", "office", "tunnel1", v.tunnel1Up ? 1 : 0, v.tunnel1Health),
      edge("office-tunnel2", "office", "tunnel2", v.tunnel2Up ? 1 : 0, v.tunnel2Health),
      edge(
        "tunnel1-route",
        "tunnel1",
        "route",
        v.selectedTunnel === 1 ? 1 : 0,
        v.selectedTunnel === 1 ? v.routeHealth : "ok",
      ),
      edge(
        "tunnel2-route",
        "tunnel2",
        "route",
        v.selectedTunnel === 2 ? 1 : 0,
        v.selectedTunnel === 2 ? v.routeHealth : "ok",
      ),
      edge(
        "route-policy",
        "route",
        "policy",
        v.offered > 0 ? v.delivered / v.offered : 0,
        v.policyHealth,
      ),
      edge("policy-app", "policy", "app", v.offered > 0 ? v.delivered / v.offered : 0, v.appHealth),
    ],
    metrics: [
      metric(
        "delivered-mbps",
        "Delivered traffic",
        v.delivered,
        " Mbps",
        undefined,
        undefined,
        "number",
      ),
      metric("drop-rate", "End-to-end drop", v.dropRate, "%", 1, 5, "percent"),
      metric(
        "tunnel-utilization",
        "Selected tunnel utilization",
        v.utilization,
        "%",
        80,
        95,
        "percent",
      ),
      metric("tunnel-latency", "Tunnel latency", v.latency, " ms", 40, 80, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${mbps(v.offered)} offered; ${mbps(v.delivered)} delivered; ${v.mode}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "drop-rate",
    metricId: "drop-rate",
    warn: 1,
    crit: 5,
    title: "Tunnel state does not match the forwarding path",
    cause:
      "The selected route points at a tunnel that is down, or the security policy blocks the traffic after the tunnel is established. The tunnel can still show up in the console.",
    fix: "Check the route target first, then the policy. Move the route to a live tunnel or let BGP withdraw the dead path. A policy fix only helps when the route already selects a live tunnel.",
    checkFirst: [
      "Read the route table and the tunnel it selects.",
      "Check both tunnel states, not only the connection state.",
      "Check the security policy, traffic selectors, and security group rules for the on-premises prefix.",
    ],
  },
  {
    id: "tunnel-utilization",
    metricId: "tunnel-utilization",
    warn: 80,
    crit: 95,
    title: "The selected tunnel is near its capacity",
    cause:
      "A single tunnel carries all traffic after failover, or the offered load exceeds the tunnel's bandwidth. AWS provides two tunnels for availability, not a single pool of twice the bandwidth.",
    fix: "Spread traffic across both tunnels with BGP multipath where supported, reduce load, or use Direct Connect for the bulk. Adding a tunnel does not double the throughput of one flow.",
    checkFirst: [
      "Confirm both tunnels are up and both are selected or advertised.",
      "Compare the offered load with the per-tunnel ceiling.",
      "Check whether ECMP is actually installing both paths.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const vpnModel: SimModel = {
  id: "cloud-networking-vpn",
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
    const jitter = rng.between(-1, 1);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "delivered-mbps" && values.delivered > 0) {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      if (item.id === "tunnel-latency" && values.delivered > 0) {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (!values.selectedUp && values.tunnelsUp > 0 && frame.flags.routeLogged !== 1) {
      pushEvent(next, {
        id: "vpn-route-missing",
        severity: "crit",
        title:
          values.routeTarget === 0
            ? "A tunnel is up, but no route matches the prefix"
            : "A tunnel is up, but the route selects another tunnel",
        detail:
          values.routeTarget === 0
            ? `No route selects a tunnel, so the ${values.tunnelsUp === 1 ? "established tunnel is" : "established tunnels are"} unused. Tunnel state alone is not connectivity.`
            : `Tunnel ${values.selectedTunnel} is the route target and it is not established. A healthy tunnel ${values.tunnelsUp === 1 ? "is" : "may be"} present but is not selected. Tunnel state alone is not connectivity.`,
        nodeId: "route",
        metricId: "drop-rate",
      });
    }
    next.flags.routeLogged = !values.selectedUp && values.tunnelsUp > 0 ? 1 : 0;
    if (values.selectedUp && !values.policy && frame.flags.policyLogged !== 1) {
      pushEvent(next, {
        id: "vpn-policy-deny",
        severity: "crit",
        title: "Tunnel and route are fine; the policy blocks traffic",
        detail:
          "The selected tunnel is established, but the security policy, traffic selector, or security group denies the flow. The tunnel looks healthy because it is healthy.",
        nodeId: "policy",
        metricId: "drop-rate",
      });
    }
    next.flags.policyLogged = values.selectedUp && !values.policy ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `${mbps(values.offered)} offered; ${mbps(values.delivered)} delivered; ${values.mode}.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.selectedUp) {
      items.push(
        `Tunnel ${v.routeTarget || "none"} is the selected target, and ${v.tunnelsUp} tunnel${v.tunnelsUp === 1 ? " is" : "s are"} up. The route, not the tunnel count, decides whether traffic flows.`,
      );
    } else if (!v.policy) {
      items.push(
        `Tunnel ${v.selectedTunnel} is up and selected, but the policy denies the flow. A ping may fail for the same reason a request does, so check the policy before blaming the tunnel.`,
      );
    } else if (v.utilization >= 80) {
      items.push(
        `The selected tunnel carries ${mbps(v.delivered)} of an illustrative ${mbps(TUNNEL_CAPACITY_MBPS)} ceiling. The second tunnel does not add capacity to this path unless it is selected too.`,
      );
    } else {
      items.push(
        `Tunnel ${v.selectedTunnel} is up, selected, and permitted. ${mbps(v.delivered)} crosses it.`,
      );
    }
    items.push(
      "AWS creates two tunnels per site-to-site connection. Both should be configured and tested; one tunnel up is a degraded state, not a redundant one.",
    );
    items.push(
      "Static routes do not follow tunnel state. BGP can withdraw a dead path, but only if the session fails or the peer withdraws the prefix.",
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
    description: "Two tunnels up; traffic uses tunnel 1 at 400 Mbps and the policy permits it.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "One selected tunnel carries 1,100 Mbps, about 88% of its illustrative ceiling.",
    tone: "warn",
    params: defaults({ trafficMbps: 1100 }),
  },
  {
    id: "failure",
    label: "Route selects a down tunnel",
    description: "Tunnel 1 is up, but the route points at tunnel 2, which is down.",
    tone: "crit",
    params: defaults({ tunnelsUp: 1, routeTarget: 2, trafficMbps: 600 }),
  },
  {
    id: "policy",
    label: "Policy blocks",
    description:
      "Both tunnels are up and the route is correct, but the security policy denies the flow.",
    tone: "crit",
    params: defaults({ tunnelsUp: 2, routeTarget: 1, securityPolicy: 0, trafficMbps: 500 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "Both tunnels up, the route selects a live tunnel, and the policy permits traffic.",
    tone: "ok",
    params: defaults({ trafficMbps: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-vpn-tunnel-state",
  title: "Predict whether the tunnel is enough",
  simId: "vpn-path",
  question:
    "Both tunnels are listed in the console. A static route sends the on-premises prefix to tunnel 2, but tunnel 2 is down. Tunnel 1 is established. What happens to the traffic?",
  prediction: {
    options: [
      { id: "fallback", label: "Traffic falls back to tunnel 1 automatically because it is up." },
      {
        id: "route-drop",
        label: "Traffic is dropped because the route still selects the down tunnel.",
      },
      { id: "balance", label: "The VPN gateway balances traffic across both tunnels." },
      { id: "policy", label: "The security policy starts blocking because the tunnel failed." },
    ],
    correctOptionId: "route-drop",
    explanation:
      "The routing decision is separate from the tunnel state. A static route on the gateway or customer router keeps pointing at tunnel 2 after it goes down, so the packet is dropped before it can use tunnel 1. BGP can withdraw the failed path, and a health-checked route can move the target, but neither happens by default.",
  },
  setup: defaults({ tunnelsUp: 1, routeTarget: 2, securityPolicy: 1, trafficMbps: 600 }),
  runFor: 20,
  observe: [
    "Tunnel 1 is up and tunnel 2 is down; the route target is tunnel 2.",
    "Delivered traffic is zero while one tunnel reports established.",
    "The route node is critical and the policy node is healthy.",
    "End-to-end drop is 100%, so the failure is visible even while paused.",
    "The healthy tunnel carries nothing because no route points at it.",
  ],
  explain:
    "A VPN connection is two tunnels, but a route chooses one next hop. A static route does not observe tunnel liveness. The fix is to point the route at a live tunnel or to run BGP over both tunnels so the failed path is withdrawn and the remaining path is selected.",
  fix: defaults({ tunnelsUp: 2, routeTarget: 1, securityPolicy: 1, trafficMbps: 400 }),
  debrief:
    "With both tunnels up and the route on tunnel 1, traffic flows. The tunnel state was never the missing piece; the route was. In production, test the failover by bringing down the selected tunnel, not by checking that both tunnels are listed.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A site-to-site VPN connects an on-premises network to a VPC over the internet. AWS creates a virtual private gateway or transit gateway attachment and a customer gateway that represents your router. Each connection has two tunnels, each with its own Internet Key Exchange (IKE) and IPsec security association, so one tunnel can fail without taking the connection down.",
  },
  {
    type: "p",
    text: "A tunnel being up means the IKE and IPsec negotiation succeeded. It does not mean a route selects the tunnel, that the traffic selectors match, or that a security group allows the packet. Those are separate checks, and each one can fail while the tunnel stays green.",
  },
  {
    type: "p",
    text: "Routing can be static or BGP. Static routes are simple and do not react to tunnel state. BGP advertises prefixes over the tunnels, withdraws a path when the session fails, and lets the route table converge on the surviving path. The tradeoff is more configuration and a dependence on session timers.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is on-premises host, customer gateway, internet, AWS VPN endpoint, tunnel, virtual private gateway or transit gateway, VPC route table, security groups, workload. The return path has its own route and policy. The VPN is not a private circuit; it is an encrypted overlay on the public internet.",
  },
  {
    type: "table",
    headers: ["Check", "What it proves", "What it does not prove"],
    rows: [
      ["Tunnel state", "IKE and IPsec are established", "A route selects the tunnel"],
      ["Route table", "A prefix selects the VPN path", "The tunnel is up or the policy permits"],
      ["Security policy", "The flow is allowed", "The return path exists"],
      ["Ping or request", "Some flow completed", "All prefixes and both tunnels work"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Tunnel 1 and tunnel 2 states, independently.",
      "The route target: no route, tunnel 1, or tunnel 2.",
      "The security policy decision, which can fail after the route succeeds.",
      "Delivered Mbps and end-to-end drop, so a green tunnel with no traffic is obvious.",
      "Selected tunnel utilization, which exposes the capacity ceiling after failover.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Route selects a down tunnel and note that one tunnel is still green; the route is the failure. Then switch to Policy blocks and compare which node is critical. Run the experiment before revealing the explanation, then set both tunnels up and move the route to the live one.",
  },
  {
    type: "p",
    text: "The model uses a 1,250 Mbps ceiling per tunnel and an 18 ms tunnel latency. Both are illustrative teaching values. The route target stands for the gateway or customer-router decision that chooses a tunnel; a VPC route table itself points at a virtual private gateway or transit gateway attachment. Real throughput depends on the tunnel, the encryption settings, the instance or gateway, and the traffic mix.",
  },
  { type: "sim", simId: "vpn-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the first failure, one tunnel was established and the other was down. The route pointed at the down tunnel, so every packet was dropped. The console would show a healthy tunnel and a healthy connection while the application saw nothing. The route target, not the tunnel list, decided the outcome.",
  },
  {
    type: "p",
    text: "In the policy failure, both tunnels were up and the route was correct. The policy node was critical and delivery was zero. That is a different fix: changing the route would not help, and restarting the tunnel would not either. Reading which node failed prevents a random repair.",
  },
  {
    type: "p",
    text: "At peak, the selected tunnel carried 1,100 Mbps, above the 80% warning line. Delivery still completed. The model shows utilization because the second tunnel does not automatically add bandwidth to a flow that is pinned to one path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "VPN console: connection state, tunnel state, last tunnel status change, and the customer gateway address.",
      "Tunnel details: IKE and IPsec security association status, bytes in and out, and traffic selector matches.",
      "Route tables: the prefix, target, and whether the route is propagated or static.",
      "BGP: advertised and received prefixes, AS path, and session uptime for each tunnel.",
      "Security: security groups, network ACLs, and the on-premises firewall for both directions.",
      "Flow logs and captures: where the packet was last seen, which is more useful than a tunnel icon.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the route target before the tunnel state. If the route points at a down tunnel, nothing else matters until it moves. Then check the policy and the return path. Use tunnel state as an input, not as the answer.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the prefix that should use the VPN and the route target that currently wins.",
      "Compare the target with the tunnel states. If the target is down, move the route to a live tunnel.",
      "If the route is correct, check the security policy, traffic selectors, and security group rules in both directions.",
      "Confirm the return route on the on-premises side and the VPC side.",
      "For durable failover, advertise the prefix over both tunnels with BGP and verify that the backup is selected after the primary fails.",
      "Test with a real flow, not only a tunnel status check, and measure the delivered rate.",
      "Record the tunnel, route, and policy state at the time of failure so the next incident is faster.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Static routes are simple and predictable, but they do not follow tunnel state. BGP is more complex and converges; it also depends on timers and session health.",
      "Two tunnels improve availability, not the throughput of a single flow. Spreading traffic across both needs multipath support and a design that tolerates it.",
      "A VPN is cheaper and faster to provision than Direct Connect, but it shares the public internet and has a smaller, less predictable capacity envelope.",
      "Keeping the primary path preferred is sensible until it fails. The cost is a longer failover if failure detection is slow.",
      "A broad security policy is easier to debug and worse to own. Narrow rules make the policy check more specific and the incident less ambiguous.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "vpn-up-no-flow",
    question:
      "A site-to-site VPN shows both tunnels up, but the application cannot reach the on-premises service. Walk me through your checks.",
    difficulty: 3,
    hints: [
      "Separate the tunnel, the route, the policy, and the return path.",
      "A tunnel can be up and unused.",
    ],
    answer:
      "I would start with the route table: which prefix matches the destination, and which tunnel is the target? Then I would compare that target with the tunnel states. If the route points at a down tunnel, I would move it or let BGP withdraw the path. If the route is correct, I would check the traffic selectors, security policy, security groups, and network ACLs in both directions, then the return route and the on-premises firewall. Finally I would run a real flow and check bytes on the tunnel; a green tunnel with no bytes is a routing or policy clue, not proof of connectivity.",
    followUps: [
      "What would you check first if only one prefix fails?",
      "How do you verify the return path?",
      "What does BGP add over a static route here?",
    ],
    redFlags: [
      "Restarts the tunnel before checking routes.",
      "Treats both tunnels up as end-to-end health.",
      "Checks only the AWS side.",
    ],
    rubric: [
      "Orders the checks: route, tunnel, policy, return path.",
      "Distinguishes tunnel state from route selection.",
      "Checks both directions.",
      "Uses real traffic evidence.",
    ],
  },
  {
    id: "vpn-two-tunnels",
    question:
      "Why does AWS create two tunnels for one site-to-site VPN connection, and what do you have to do to benefit?",
    difficulty: 2,
    hints: [
      "Availability is not automatic just because two tunnels exist.",
      "Both tunnels need configuration and a routing decision.",
    ],
    answer:
      "The two tunnels give the connection a second path if one tunnel or one AWS endpoint fails. To benefit, both tunnels must be configured on the customer gateway, both must be advertised or routed, and the routing policy must allow the surviving path to be selected. With static routing, I need a plan to change the route or a health check that does it. With BGP, I need both sessions established and the backup path advertised. I would test by bringing down the selected tunnel and confirming traffic moves.",
    followUps: [
      "What happens if only one tunnel is configured?",
      "How does BGP choose between the two tunnels?",
      "What would you monitor?",
    ],
    redFlags: [
      "Assumes AWS fails over automatically.",
      "Configures only one tunnel.",
      "Never tests the failover.",
    ],
    rubric: [
      "Explains the two-tunnel design.",
      "Names configuration and routing requirements.",
      "Tests the failure.",
      "Mentions monitoring both tunnels.",
    ],
  },
  {
    id: "vpn-vs-dx",
    question: "When would you choose a VPN over Direct Connect, and when would you use both?",
    difficulty: 3,
    hints: [
      "Compare private dedicated capacity with internet economics.",
      "Think about the backup's capacity and failure domain.",
    ],
    answer:
      "A VPN is a good fit for smaller, less latency-sensitive traffic, for a quick secondary path, or for a site that cannot justify a dedicated circuit. Direct Connect is a better fit for predictable high-volume or latency-sensitive traffic and for private connectivity that should not depend on the public internet. Using both is common: Direct Connect carries the bulk, and the VPN provides a diverse backup or a path for sites that do not need dedicated capacity. The backup must be sized and tested for the load it will actually carry, and it should not share the same failure domain as the primary.",
    followUps: [
      "How would you size the VPN backup?",
      "What does the VPN not protect against?",
      "How do you keep the paths diverse?",
    ],
    redFlags: [
      "Treats the VPN as a drop-in replacement at any scale.",
      "Assumes a backup is useful without testing.",
      "Ignores the public internet path.",
    ],
    rubric: [
      "Matches the technology to the workload.",
      "Names capacity and failure-domain tradeoffs.",
      "Sizes and tests the backup.",
      "Describes a combined design.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Both tunnels are configured on the customer gateway, not only one.",
      "The routing mode, static or BGP, is documented with the prefixes it advertises.",
      "The security policy and traffic selectors are reviewed for both directions.",
      "A failover test has brought down the selected tunnel and measured recovery.",
      "Alerts cover tunnel state, route presence, and delivered traffic.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the winning route and its tunnel target before changing the tunnel.",
      "Check both tunnel states and the BGP session state.",
      "Check the policy, traffic selectors, and security groups in both directions.",
      "Confirm the return route on the on-premises side.",
      "Measure delivered traffic, not only tunnel status.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore both tunnels and confirm the backup is selectable.",
      "Re-test failover with the production traffic profile.",
      "Record the route, tunnel, and policy state at failure time.",
      "Add a check for the specific gap that was found.",
    ],
  },
];

const references = [
  {
    title: "What is AWS Site-to-Site VPN?",
    url: "https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connections, customer gateways, virtual private gateways, and the two-tunnel design.",
  },
  {
    title: "Tunnel options for your Site-to-Site VPN connection",
    url: "https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNTunnels.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "IKE and IPsec tunnel options, dead peer detection, and what a tunnel up state does and does not mean.",
  },
  {
    title: "Site-to-Site VPN routing",
    url: "https://docs.aws.amazon.com/vpn/latest/s2svpn/VPNRoutingTypes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Static and BGP routing options and how routes are installed for VPN connections.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vpn-path": {
      model: vpnModel,
      presets,
      instructions:
        "Start Healthy, then compare a down route target with a policy block. Watch which node is critical and which stays green. Finish with the recovery preset and the experiment.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The per-tunnel ceiling is 1,250 Mbps and latency is 18 ms; these are teaching values, not guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-direct-connect",
    "cloud-networking-bgp",
    "cloud-networking-route-propagation",
    "cloud-networking-route-tables",
  ],
};
