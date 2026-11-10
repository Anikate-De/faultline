import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, MAX_EVENTS, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CLIENT_CIDR = "203.0.113.0/24";
const WEB_CIDR = "10.0.1.0/24";
const APP_CIDR = "10.0.2.0/24";
const SERVICE_PORT = 8080;

const params = [
  {
    id: "forwardRules",
    label: "Forward rules present",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Subnet ACLs",
    help: "1 allows the client on TCP 443 into the web subnet, the web tier out on TCP 8080 to the app subnet, and the app tier in on TCP 8080. 0 removes one of those rules.",
    format: "count" as const,
  },
  {
    id: "appReturn",
    label: "App return allowed",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Return path",
    help: "1 allows the app subnet out to the web subnet on ephemeral ports and the web subnet in from the app subnet on ephemeral ports. The response is a separate flow to the ACL.",
    format: "count" as const,
  },
  {
    id: "clientReturn",
    label: "Client return allowed",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Return path",
    help: "1 allows the web subnet out to the client CIDR on ephemeral ports. 0 lets requests arrive while every response is dropped at the subnet boundary.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Client requests",
    min: 100,
    max: 3_000,
    step: 100,
    value: 800,
    unit: " /s",
    group: "Traffic",
    help: "Illustrative requests per second. Each request expects one response on the client's ephemeral port.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  forwardRules: boolean;
  appReturn: boolean;
  clientReturn: boolean;
  demand: number;
  forwarded: number;
  replied: number;
  delivered: number;
  blocked: number;
  returnDrops: number;
  deliveryRate: number;
  clientHealth: Health;
  webAclHealth: Health;
  appAclHealth: Health;
  serviceHealth: Health;
}

function compute(p: Params): Computed {
  const forwardRules = num(p, "forwardRules", 1) >= 0.5;
  const appReturn = num(p, "appReturn", 1) >= 0.5;
  const clientReturn = num(p, "clientReturn", 1) >= 0.5;
  const demand = Math.max(1, num(p, "requestRate", 800));
  const forwarded = forwardRules ? demand : 0;
  const replied = forwarded > 0 && appReturn ? forwarded : 0;
  const delivered = replied > 0 && clientReturn ? replied : 0;
  const blocked = demand - delivered;
  const returnDrops = forwarded - delivered;
  return {
    forwardRules,
    appReturn,
    clientReturn,
    demand,
    forwarded,
    replied,
    delivered,
    blocked,
    returnDrops,
    deliveryRate: clamp((delivered / demand) * 100, 0, 100),
    clientHealth: delivered === demand ? "ok" : "warn",
    webAclHealth: !forwardRules || !clientReturn ? "crit" : !appReturn ? "warn" : "ok",
    appAclHealth: !appReturn ? "crit" : !forwardRules ? "warn" : "ok",
    serviceHealth: delivered === demand ? "ok" : forwarded === 0 ? "warn" : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPct(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.3);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value = item.value * jitter(index);
      return item.format === "percent" ? clamp(value, 0, 100) : Math.max(0, value);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const droppedAtEntry = v.forwarded === 0;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "internet clients",
        kind: "client",
        health: v.clientHealth,
        throughput: v.delivered,
        sublabel: `${formatCount(v.demand)} requests/s`,
        detail:
          "The client connects to TCP 443 and expects the response on the ephemeral port it chose. Many Linux clients use 32768–61000; Windows Server 2008 and later use 49152–65535; load balancers and Lambda use 1024–65535.",
        meta: { view: "flow" },
      },
      {
        id: "web-acl",
        label: "acl-web",
        kind: "mesh",
        health: v.webAclHealth,
        sublabel: "subnet 10.0.1.0/24",
        detail: v.forwardRules
          ? v.clientReturn
            ? "Inbound TCP 443 from the client CIDR is allowed, and outbound traffic to the client CIDR on ephemeral ports is allowed. This ACL also carries the web-to-app flow and its return."
            : "Inbound TCP 443 is allowed, but there is no outbound rule for the client CIDR on ephemeral ports. Requests enter; responses are denied when they leave the subnet."
          : "An inbound or outbound forward rule is missing. The request is denied at the subnet boundary before the application sees it.",
        meta: { view: "flow" },
      },
      {
        id: "app-acl",
        label: "acl-app",
        kind: "mesh",
        health: v.appAclHealth,
        sublabel: `subnet ${APP_CIDR}`,
        detail: v.appReturn
          ? `Inbound TCP ${SERVICE_PORT} from ${WEB_CIDR} is allowed, and outbound ephemeral ports to ${WEB_CIDR} are allowed for the response.`
          : `Inbound TCP ${SERVICE_PORT} is allowed, but the outbound ephemeral rule to ${WEB_CIDR} is missing. The app receives the request and its response is denied at the subnet boundary.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "app service",
        kind: "service",
        health: v.serviceHealth,
        throughput: v.forwarded,
        sublabel: droppedAtEntry ? "no requests arrive" : `${formatCount(v.replied)} replies/s`,
        detail: droppedAtEntry
          ? "The service is running, but no request reaches the app subnet. A healthy process is not evidence that the ACL path is open."
          : v.appReturn
            ? "The service receives the request and sends a response to the web tier's ephemeral port. The security group is stateful; the subnet ACL is not."
            : "The service receives and answers the request. The answer is dropped by the app subnet's outbound ACL rule.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-web-acl", "client", "web-acl", v.forwardRules ? 1 : 0, v.forwardRules ? "ok" : "crit"),
      edge("web-acl-app-acl", "web-acl", "app-acl", v.forwarded > 0 ? 1 : 0, v.forwarded > 0 ? "ok" : "crit"),
      edge("app-acl-service", "app-acl", "service", v.replied > 0 ? 1 : 0, v.replied > 0 ? "ok" : "crit"),
      edge(
        "service-web-acl",
        "service",
        "web-acl",
        v.delivered > 0 ? 1 : 0,
        v.delivered > 0 ? "ok" : "crit",
        "response",
      ),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", v.deliveryRate, "%", undefined, undefined, "percent"),
      metric("blocked-requests", "Blocked requests", v.blocked, " /s", 1, 50, "rps"),
      metric("return-drops", "Dropped responses", v.returnDrops, " /s", 1, 50, "rps"),
      metric("forwarded-requests", "Requests reaching app", v.forwarded, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      forwardRules: v.forwardRules ? 1 : 0,
      appReturn: v.appReturn ? 1 : 0,
      clientReturn: v.clientReturn ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} requests/s → ${formatPct(v.deliveryRate)}% delivered; ${formatCount(
      v.returnDrops,
    )} responses dropped at a subnet ACL.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blocked-requests",
    metricId: "blocked-requests",
    warn: 1,
    crit: 50,
    title: "Requests are denied at a subnet boundary",
    cause:
      "A network ACL rule is missing or a lower-numbered deny rule matched first. A security group allow rule cannot override the subnet ACL, and it does not create an ACL rule for the response.",
    fix:
      "Read both ACLs in the path, add the necessary allow rule in the correct direction, and verify the rule number places it before any broad deny. Then retest the request and the response.",
    checkFirst: [
      "Identify which subnet ACL is associated with each ENI in the path.",
      "Read the inbound and outbound rules that match the flow, including the ephemeral response.",
      "Check rule order: the lowest-numbered matching rule wins, including deny rules.",
    ],
  },
  {
    id: "return-drops",
    metricId: "return-drops",
    warn: 1,
    crit: 50,
    title: "The request arrives but its response is dropped",
    cause:
      "The response is a separate stateless evaluation in the reverse direction. The destination port is the client's ephemeral port, not the listener port, so an outbound or inbound ephemeral allow rule is missing.",
    fix:
      "Allow the response direction on the ephemeral range. For internet clients, 1024–65535 covers Linux, Windows, load balancers, NAT gateways, and Lambda, at the cost of a wider rule.",
    checkFirst: [
      "Compare the request's destination port with the response's destination port.",
      "Check the ACL on both the source and destination subnet for the return direction.",
      "Confirm the response is not being dropped by a security group; security groups are stateful and usually allow the return automatically.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const naclsModel: SimModel = {
  id: "cloud-networking-nacls",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const v = compute(p);
    const previous = {
      forwardRules: Number(frame.flags.forwardRules ?? 1),
      appReturn: Number(frame.flags.appReturn ?? 1),
      clientReturn: Number(frame.flags.clientReturn ?? 1),
    };
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const jitter = v.blocked > 0 ? rng.between(-0.3, 0.3) * clamp(dt * 10, 0, 1) : 0;
    next.metrics = next.metrics.map((item) =>
      item.id === "blocked-requests" && v.blocked > 0
        ? { ...item, value: Math.max(0, item.value + jitter) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (previous.forwardRules === 1 && !v.forwardRules) {
      pushEvent(next, {
        id: "forward-rule-removed",
        at: frame.t,
        severity: "crit",
        title: "Forward ACL rule removed",
        detail:
          "The request no longer reaches the app subnet. Check the web subnet's inbound listener rule, its outbound rule to the app CIDR, and the app subnet's inbound service-port rule.",
        nodeId: "web-acl",
        metricId: "blocked-requests",
      });
    }
    if (previous.appReturn === 1 && !v.appReturn) {
      pushEvent(next, {
        id: "app-return-removed",
        at: frame.t,
        severity: "crit",
        title: "App subnet cannot send responses",
        detail: `The app receives TCP ${SERVICE_PORT} requests but has no outbound ephemeral rule to ${WEB_CIDR}. Security group statefulness does not apply to the subnet ACL.`,
        nodeId: "app-acl",
        metricId: "return-drops",
      });
    }
    if (previous.clientReturn === 1 && !v.clientReturn) {
      pushEvent(next, {
        id: "client-return-removed",
        at: frame.t,
        severity: "crit",
        title: "Client responses denied at the web subnet",
        detail: `Requests reach the app, but the web subnet has no outbound ephemeral rule to ${CLIENT_CIDR}. Every response is denied on the way out.`,
        nodeId: "web-acl",
        metricId: "return-drops",
      });
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.forwardRules) {
      items.push(
        "No request reaches the app subnet. The missing rule is on the forward path, so changing the return path will not help.",
      );
    } else if (!v.appReturn) {
      items.push(
        `The app receives ${formatCount(v.forwarded)} requests/s and answers them, but its subnet ACL denies the outbound response to ${WEB_CIDR}. The request port is ${SERVICE_PORT}; the response destination is an ephemeral port.`,
      );
    } else if (!v.clientReturn) {
      items.push(
        `Requests traverse both subnets and the app replies, but the web subnet denies the response to ${CLIENT_CIDR}. The client sees a timeout, not a connection refusal.`,
      );
    } else {
      items.push(
        `All ${formatCount(v.demand)} requests/s complete. Both the forward and return directions have matching allow rules in every subnet ACL on the path.`,
      );
    }
    items.push(
      "NACLs are stateless: each direction is evaluated separately at the subnet boundary, with no memory of the request. Security groups are stateful and allow the response automatically.",
    );
    items.push(
      "Rule order matters. The lowest-numbered matching rule is applied and later rules are not evaluated, so a deny must be placed before a broad allow if it is meant to override it.",
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
    description: "Forward and return rules exist in both subnet ACLs; every request completes.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher request rate with the same complete rule set; ACLs do not queue traffic.",
    tone: "info",
    params: defaults({ requestRate: 2_500 }),
  },
  {
    id: "failure",
    label: "Client return blocked",
    description: "Requests reach the app, but the web subnet denies responses to the client CIDR.",
    tone: "crit",
    params: defaults({ clientReturn: 0 }),
  },
  {
    id: "app-return",
    label: "App return blocked",
    description: "The app subnet has no outbound ephemeral rule, so responses to the web tier are denied.",
    tone: "crit",
    params: defaults({ appReturn: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Both return rules are restored and delivery completes again.",
    tone: "ok",
    params: defaults({ requestRate: 900 }),
  },
];

const experiment: Experiment = {
  id: "predict-client-return",
  title: "Predict which rule is missing",
  simId: "acl-path",
  question:
    "Security groups on both instances allow the traffic. Requests reach the app service, the app sends replies, but clients never receive a response. Which rule is missing?",
  prediction: {
    options: [
      { id: "inbound-listener", label: "An inbound rule for TCP 443 on the web subnet ACL." },
      { id: "app-outbound", label: "An outbound ephemeral rule on the app subnet ACL." },
      { id: "client-outbound", label: "An outbound ephemeral rule on the web subnet ACL toward the client CIDR." },
      { id: "security-group", label: "A security group outbound rule on the web instance." },
    ],
    correctOptionId: "client-outbound",
    explanation:
      "The response leaves the web subnet toward the client. Its destination port is the client's ephemeral port, so the web subnet ACL needs an outbound allow rule on the ephemeral range. The security group is stateful and does not need a matching outbound rule.",
  },
  setup: defaults({ forwardRules: 1, appReturn: 1, clientReturn: 0, requestRate: 800 }),
  runFor: 15,
  observe: [
    "Requests reach the app service and the app produces replies.",
    "End-to-end delivery is 0% while the forward path looks healthy.",
    "Dropped responses equal the offered request rate.",
    "The web subnet ACL is failing; the app subnet ACL is healthy.",
    "The client health is degraded but the client is not the cause.",
  ],
  explain:
    "The request and the response are separate flows. The request is client ephemeral port to TCP 443. The response is TCP 443 to the client's ephemeral port. The web subnet ACL evaluates the response outbound and finds no matching allow rule, so it applies the final deny. Adding a security group rule changes nothing because the packet never reaches the instance's security group on the way out.",
  fix: defaults({ forwardRules: 1, appReturn: 1, clientReturn: 1, requestRate: 800 }),
  debrief:
    "A stateless ACL needs a rule for each direction. Return traffic is not remembered, and the port that matters on the response is the client's ephemeral port. In production, allow 1024–65535 for internet-facing responses or narrow the range to the client operating systems you actually serve.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A network access control list (ACL) is an ordered set of allow and deny rules applied at the subnet boundary. Each subnet is associated with exactly one ACL. A custom ACL has inbound and outbound rules, and each rule has a number, a protocol, a port range, a CIDR source or destination, and an allow or deny action.",
  },
  {
    type: "p",
    text: "AWS evaluates the rules from the lowest number upward. The first rule that matches is applied and no later rule is considered. If nothing matches, the implicit final rule denies the traffic. Rules are evaluated when traffic enters or leaves the subnet, not while it moves between instances inside the same subnet.",
  },
  {
    type: "p",
    text: "The important word is stateless. The ACL keeps no record of a request, so it does not automatically allow the response. A security group is stateful: an allowed inbound connection can return traffic without a separate outbound rule. An ACL needs both directions written out, and the response usually targets an ephemeral port chosen by the client.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, route table, subnet ACL inbound, instance security group, application. The response leaves the application, passes the security group (stateful), then the same subnet ACL outbound, then the route table. With two subnets, both ACLs evaluate the flow: the app subnet sees the request enter and the response leave, and the web subnet sees the request leave toward the app and the response return.",
  },
  {
    type: "table",
    headers: ["ACL", "Direction", "Rule", "Why it exists"],
    rows: [
      ["acl-web", "inbound", "TCP 443 from 0.0.0.0/0", "Clients reach the web listener."],
      ["acl-web", "outbound", "TCP 8080 to 10.0.2.0/24", "The web tier calls the app tier."],
      ["acl-web", "outbound", "TCP 1024–65535 to client CIDR", "Responses leave toward the client's ephemeral port."],
      ["acl-app", "inbound", "TCP 8080 from 10.0.1.0/24", "The app accepts the web tier request."],
      ["acl-app", "outbound", "TCP 1024–65535 to 10.0.1.0/24", "The app response returns to the web tier's ephemeral port."],
      ["acl-web", "inbound", "TCP 1024–65535 from 10.0.2.0/24", "The web tier receives the app response."],
    ],
  },
  {
    type: "p",
    text: "The response port depends on the client. Many Linux kernels, including Amazon Linux, use 32768–61000. Windows Server 2008 and later use 49152–65535. Elastic Load Balancing, NAT gateways, and Lambda use 1024–65535. Opening 1024–65535 covers all of them; a narrower range is tighter but must match every client you serve.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Forward rules: whether the request can cross the web subnet inbound and reach the app subnet.",
      "App return: whether the app subnet can send its response back to the web tier.",
      "Client return: whether the web subnet can send the response to the client's ephemeral port.",
      "Delivery, blocked requests, and dropped responses: the difference between a request arriving and a request completing.",
      "Node health on each ACL, so the failing subnet boundary is visible while paused.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and read the rule table before moving a slider. Apply Client return blocked: requests still reach the app, but delivery falls to zero. Then restore it and apply App return blocked. Compare which ACL fails in each case. Run the guided experiment before revealing its explanation, then widen and narrow the ephemeral range and note what the rule actually covers.",
  },
  {
    type: "p",
    text: "This model uses an illustrative 800 requests per second and a two-subnet path. The rates are teaching values, not AWS limits. The rule semantics, ephemeral port behavior, and first-match evaluation are the parts to carry into production.",
  },
  { type: "sim", simId: "acl-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The request path was open while the response path was closed. The app received requests and produced replies, but the web subnet ACL had no outbound allow rule for the client CIDR on the ephemeral range. The final deny rule dropped every response, so delivery was zero even though the request path looked healthy.",
  },
  {
    type: "p",
    text: "The app-return variant moved the failure one subnet inward. The web tier could reach the app, but the app subnet had no outbound ephemeral rule back to the web CIDR. The app was healthy, the security groups were correct, and the packet still never left the subnet.",
  },
  {
    type: "p",
    text: "Raising the request rate did not change delivery because an ACL does not queue traffic. It matches or drops each packet. Rate only changes how many packets are dropped per second, which is why the blocked count scales while the delivery percentage stays at zero.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "VPC Flow Logs show REJECT records at the ENI for traffic denied by a security group or network ACL. Use them to find the direction and the address pair, then read the ACL rules.",
      "Client symptoms are timeouts, not connection refusals, because the packet is dropped silently. Retries and elevated latency often appear before anyone checks the subnet.",
      "The security group can look completely correct. A target that allows the load balancer on the service port still fails if the subnet ACL blocks the response.",
      "Health checks fail when the load balancer's health-check traffic is denied in either direction. A target can be marked unhealthy while the application is running.",
      "Reachability Analyzer evaluates the configuration and can name a network ACL as the blocking component. It does not prove the live data plane.",
      "Both subnets matter. A rule change on the web ACL cannot fix a response dropped by the app ACL, and the reverse is also true.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Identify the exact direction that fails, then read the ACL associated with that subnet. Check the ephemeral range before changing the listener rule. Confirm rule order after adding a rule, because a lower-numbered deny still wins. Do not widen a security group to compensate for an ACL drop.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the five-tuple for the failing flow, including the response direction and its destination port.",
      "Find the subnet ACL for each ENI on the path and read the rules that match that five-tuple.",
      "Add the missing allow rule in the correct direction. For internet clients, allow TCP 1024–65535 outbound to the client CIDR.",
      "Place any deny rule below the allow rule it must override, using rule numbers with gaps for later inserts.",
      "Check the reverse subnet as well: a two-subnet path has two ACLs and each one evaluates both directions.",
      "Retest with a real request and confirm a response, then test at peak rate and from each client operating system you support.",
      "Record the change and add a check that alerts on rejected flow-log records or failed synthetic transactions, not only on ACL rule count.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Opening 1024–65535 is operationally simple and covers Linux, Windows, load balancers, NAT gateways, and Lambda. It is also a wide range that weakens the ACL as a guardrail.",
      "Narrowing to one operating system's range is tighter but fails when a new client type appears. Match the range to the clients you actually serve and document the assumption.",
      "Security groups are easier for service-to-service rules because they are stateful and can reference other groups. ACLs are coarser, CIDR-based, and apply to every resource in the subnet.",
      "An ACL is a blunt instrument with a large blast radius: associating a changed ACL with a subnet affects every ENI in it. Test on a non-production subnet first.",
      "A deny rule can enforce a block that a security group cannot express, but it must be ordered before the allow rule. Ordering mistakes create outages that look like missing routes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stateful-vs-stateless",
    question:
      "A security group allows inbound HTTPS and the application replies, but the client never receives the response. The route tables are correct. Where do you look, and why?",
    difficulty: 2,
    hints: [
      "The response is evaluated separately at the subnet boundary.",
      "The destination port on the response is not 443.",
    ],
    answer:
      "I would check the network ACL on the subnet that carries the response. NACLs are stateless, so the response is a separate evaluation in the reverse direction. The response's destination port is the client's ephemeral port, so the ACL needs an outbound allow rule for that range toward the client CIDR. If the app is in a second subnet, I would also check its outbound ephemeral rule and the web subnet's inbound ephemeral rule. Security groups are stateful and do not need a matching outbound rule, which is why they can look correct while the ACL drops the packet.",
    followUps: [
      "Which ephemeral range would you allow for internet clients?",
      "How would flow logs confirm the direction?",
      "Why does a timeout differ from a connection refusal here?",
    ],
    redFlags: [
      "Says the security group must allow outbound return traffic.",
      "Only checks the inbound listener rule.",
      "Assumes the route table is the cause without reading the ACL.",
    ],
    rubric: [
      "Names the response as a separate stateless evaluation.",
      "Identifies the ephemeral destination port.",
      "Checks both subnets in a two-tier path.",
      "Distinguishes ACL behavior from security group statefulness.",
    ],
  },
  {
    id: "ephemeral-range",
    question:
      "Why do AWS examples allow 1024–65535 for return traffic instead of only 32768–61000? What is the cost of the wider range?",
    difficulty: 2,
    hints: [
      "The client chooses the source port.",
      "Different clients use different ranges.",
    ],
    answer:
      "The client that initiates the connection chooses the ephemeral source port, and the range varies by client. Many Linux kernels use 32768–61000, Windows Server 2008 and later use 49152–65535, and Elastic Load Balancing, NAT gateways, and Lambda use 1024–65535. Allowing 1024–65535 covers all of those without knowing which client will connect. The cost is a broader allow rule, which gives an attacker more destination ports to reach if the rule's CIDR is also broad. A narrow range is tighter but must be kept in sync with the clients actually served.",
    followUps: [
      "When would you use a /24 client CIDR with the wide port range?",
      "How would you test a narrow range without breaking a client?",
      "What does the ACL rule not protect against?",
    ],
    redFlags: [
      "Says the server chooses the ephemeral port.",
      "Uses 443 for the response destination.",
      "Claims the wide range has no security cost.",
    ],
    rubric: [
      "Explains that the client chooses the source port.",
      "Names at least two real client ranges.",
      "States the security cost of a wide allow.",
      "Connects the range to the client population.",
    ],
  },
  {
    id: "rule-order",
    question:
      "You add a deny rule for a malicious port range to a subnet ACL, but the traffic still passes. The allow rule covers a wider range. What went wrong?",
    difficulty: 2,
    hints: [
      "Rules are evaluated from the lowest number.",
      "The first match is final.",
    ],
    answer:
      "The deny rule must have a lower number than the allow rule that covers the wider range. ACL evaluation starts at the lowest rule number and stops at the first match, so a broad allow with a lower number wins before the deny is reached. I would move the deny earlier or renumber the rules with gaps, then verify the rule order in the console or API. I would also check whether the traffic is entering or leaving a different subnet whose ACL does not have the deny rule at all.",
    followUps: [
      "How would you leave room for future rules?",
      "What happens if no rule matches?",
      "Does a deny rule on one subnet affect traffic inside that subnet?",
    ],
    redFlags: [
      "Adds another allow rule.",
      "Assumes deny rules always win.",
      "Ignores the second subnet.",
    ],
    rubric: [
      "States first-match evaluation from the lowest number.",
      "Moves the deny before the broad allow.",
      "Checks the other subnet's ACL.",
      "Knows the implicit final deny.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every subnet's ACL association and rule order are inventoried, including the default ACL.",
      "Internet-facing return paths allow the ephemeral range used by each supported client type.",
      "Synthetic transactions test the full request and response, not just a TCP connect.",
      "Flow-log retention and queries can show REJECT records by ENI and direction.",
      "ACL changes are reviewed with a rollback rule set and a non-production test subnet.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the failing direction before changing any rule.",
      "Read the ACL on the subnet that carries that direction, not only the source subnet.",
      "Check the response's destination port; it is usually an ephemeral port.",
      "Check rule order after adding an allow, and keep the change scoped to one subnet.",
      "Confirm with a real request and response before declaring recovery.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Document which direction failed and which rule was missing.",
      "Remove temporary broad allows and replace them with the narrowest working range.",
      "Add a test for the client operating systems that were not covered.",
      "Review other subnets for the same missing return rule.",
    ],
  },
];

const references = [
  {
    title: "Control subnet traffic with network access control lists",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-network-acls.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Stateless evaluation, subnet association, rule numbers, and the implicit deny.",
  },
  {
    title: "Network ACL rules",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nacl-rules.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rule components, lowest-number-first evaluation, and deny-before-allow ordering.",
  },
  {
    title: "Custom network ACLs and ephemeral ports",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/custom-network-acl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Ephemeral port ranges for Linux, Windows, ELB, NAT gateways, and Lambda.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "acl-path": {
      model: naclsModel,
      presets,
      instructions:
        "Start healthy, read the rule table, then remove one return rule at a time. Watch which subnet ACL fails and whether requests still reach the app.",
      experimentIds: [experiment.id],
      note: "Illustrative two-subnet path at 800 requests/s. Rates are teaching values; ACL and ephemeral-port behavior follows AWS documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-security-groups",
    "cloud-networking-subnets",
    "cloud-networking-route-tables",
    "cloud-networking-flow-logs",
  ],
};
