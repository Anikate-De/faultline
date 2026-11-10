import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import {
  clamp,
  edge,
  MAX_EVENTS,
  metric,
  pushEvent,
  recordSeries,
} from "@/simulation/engine/frame";
import { meta } from "./meta";

const ALB_SG = "sg-0a1b2c3d4e5f67890";
const TARGET_SG = "sg-0f9e8d7c6b5a43210";

const params = [
  {
    id: "albIngress",
    label: "ALB allows client traffic",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "ALB",
    help: "1 keeps the ALB security group's inbound rule on the listener port. 0 removes it, so clients cannot reach the load balancer.",
    format: "count" as const,
  },
  {
    id: "targetRef",
    label: "Target allows the ALB group",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Target",
    help: "1 adds an inbound rule on the target security group whose source is the ALB security group. This follows the ALB network interfaces instead of listing subnet CIDRs.",
    format: "count" as const,
  },
  {
    id: "broadCidr",
    label: "Target allows 0.0.0.0/0",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Target",
    help: "1 adds an inbound rule on the target port from every IPv4 address. Traffic flows, but any source that can route to the target can reach the port.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Client requests",
    min: 100,
    max: 2_000,
    step: 100,
    value: 800,
    unit: " /s",
    group: "Traffic",
    help: "Illustrative requests per second from clients to the ALB listener. The target sees only the requests the security groups allow.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  albIngress: boolean;
  targetRef: boolean;
  broadCidr: boolean;
  targetAllows: boolean;
  reachable: boolean;
  demand: number;
  delivered: number;
  blocked: number;
  deliveryRate: number;
  unhealthyTargets: number;
  exposure: number;
  clientHealth: Health;
  albHealth: Health;
  targetSgHealth: Health;
  targetHealth: Health;
}

function compute(p: Params): Computed {
  const albIngress = num(p, "albIngress", 1) >= 0.5;
  const targetRef = num(p, "targetRef", 1) >= 0.5;
  const broadCidr = num(p, "broadCidr", 0) >= 0.5;
  const targetAllows = targetRef || broadCidr;
  const demand = Math.max(1, num(p, "requestRate", 800));
  const reachable = albIngress && targetAllows;
  const delivered = reachable ? demand : 0;
  const blocked = demand - delivered;
  const exposure = broadCidr ? 100 : 0;
  return {
    albIngress,
    targetRef,
    broadCidr,
    targetAllows,
    reachable,
    demand,
    delivered,
    blocked,
    deliveryRate: reachable ? 100 : 0,
    unhealthyTargets: targetAllows ? 0 : 1,
    exposure,
    clientHealth: reachable ? "ok" : "warn",
    albHealth: albIngress ? "ok" : "crit",
    targetSgHealth: targetAllows ? (broadCidr ? "warn" : "ok") : "crit",
    targetHealth: targetAllows ? (broadCidr ? "warn" : "ok") : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.3));
      const value = wave + Math.sin(index / 2.1) * Math.max(0.1, item.value * 0.02);
      return item.format === "percent" || item.id === "exposure-breadth"
        ? clamp(value, 0, 100)
        : Math.max(0, value);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const targetRule = v.targetRef && v.broadCidr
    ? `The target security group has both a reference to ${ALB_SG} and a 0.0.0.0/0 rule. The reference is narrow, but the broad rule still exposes the port.`
    : v.targetRef
      ? `The target security group allows the target port only from ${ALB_SG}. The rule follows the ALB network interfaces without listing subnet CIDRs.`
      : v.broadCidr
        ? "The target security group allows the target port from 0.0.0.0/0. Traffic flows, but any source that can route to the target can reach it."
        : `The target security group has no inbound rule for the target port from ${ALB_SG}. The ALB health check and client requests are dropped at the target ENI.`;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "clients",
        kind: "client",
        health: v.clientHealth,
        throughput: v.demand,
        sublabel: `${formatCount(v.demand)} /s`,
        detail:
          "Clients connect to the ALB listener. The ALB security group is the first allow list; the target security group is a second, separate allow list.",
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: v.albHealth,
        throughput: v.albIngress ? v.demand : 0,
        sublabel: v.albIngress ? `${ALB_SG} · listener open` : `${ALB_SG} · no inbound rule`,
        detail: v.albIngress
          ? "The ALB security group allows clients on the listener port. The target security group must still allow the ALB on the target and health-check port."
          : "The ALB security group has no inbound rule for the listener port. Clients fail before the target is selected; the target security group is not the first problem.",
        meta: { view: "flow" },
      },
      {
        id: "target-sg",
        label: TARGET_SG,
        kind: "mesh",
        health: v.targetSgHealth,
        sublabel: v.targetRef && v.broadCidr
          ? "sources: ALB SG + 0.0.0.0/0"
          : v.targetRef
            ? "source: ALB SG"
            : v.broadCidr
              ? "source: 0.0.0.0/0"
              : "no target-port rule",
        detail: `${targetRule} Security groups are stateful: the target needs no outbound rule for the response to an allowed inbound connection.`,
        meta: { view: "flow" },
      },
      {
        id: "target",
        label: "service targets",
        kind: "service",
        health: v.targetHealth,
        throughput: v.delivered,
        sublabel: v.targetAllows
          ? v.broadCidr
            ? "exposed: 0.0.0.0/0"
            : "narrow: ALB only"
          : "blocked by target SG",
        detail: v.targetAllows
          ? "The target receives the request. Responses return through the stateful connection tracking even if the target security group has no outbound rule."
          : "The ALB health check cannot reach the target port, so the target is marked unhealthy. If every target in every enabled AZ is unhealthy, the ALB can fail open and route to all targets regardless of health, but the security group still blocks the traffic.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", v.albIngress ? 1 : 0, v.albIngress ? "ok" : "crit"),
      edge(
        "alb-target-sg",
        "alb",
        "target-sg",
        v.albIngress && v.targetAllows ? 1 : 0,
        v.targetAllows ? (v.broadCidr && !v.targetRef ? "warn" : "ok") : "crit",
      ),
      edge("target-sg-target", "target-sg", "target", v.demand > 0 ? v.delivered / v.demand : 0, v.targetHealth),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", v.deliveryRate, "%", undefined, undefined, "percent"),
      metric("blocked-connections", "Blocked requests", v.blocked, " /s", 1, 50, "rps"),
      metric("unhealthy-targets", "Targets failing health checks", v.unhealthyTargets, "", 1, 1, "count"),
      metric("exposure-breadth", "Exposure breadth (illustrative)", v.exposure, "", 1, 80, "count"),
      metric("offered-requests", "Offered requests", v.demand, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      albIngress: v.albIngress ? 1 : 0,
      targetRef: v.targetRef ? 1 : 0,
      broadCidr: v.broadCidr ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} requests/s; ${v.deliveryRate.toFixed(0)}% delivered; target rule ${
      v.targetRef ? "ALB reference" : v.broadCidr ? "0.0.0.0/0" : "missing"
    }; exposure ${v.exposure}/100.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blocked-connections",
    metricId: "blocked-connections",
    warn: 1,
    crit: 50,
    title: "The load balancer cannot reach the target security group",
    cause:
      "The target security group has no inbound rule for the target port from the ALB. The ALB security group can be correct and the request still fails at the target ENI.",
    fix:
      "Add an inbound rule on the target security group with the ALB security group as the source, on the target port and the health-check port. Do not open the target to 0.0.0.0/0.",
    checkFirst: [
      "Compare the target security group's inbound rules with the ALB security group ID.",
      "Check the target port and the health-check port, not only the listener port.",
      "Check the ALB security group's outbound rule toward the target.",
    ],
  },
  {
    id: "unhealthy-targets",
    metricId: "unhealthy-targets",
    warn: 1,
    crit: 1,
    title: "The target is failing ALB health checks",
    cause:
      "The health check uses the same target security group as client traffic. If the target port is not allowed from the ALB, the target is marked unhealthy even though the application may be running.",
    fix:
      "Allow the health-check port from the ALB security group and confirm the target's health-check path returns a success code. Re-check target health after the rule change.",
    checkFirst: [
      "Read describe-target-health for the reason code.",
      "Check the health-check port and path in the target group.",
      "Check the target security group and any network ACL in the path.",
    ],
  },
  {
    id: "exposure-breadth",
    metricId: "exposure-breadth",
    warn: 1,
    crit: 80,
    title: "The target is reachable through a broad CIDR rule",
    cause:
      "The target security group allows the service port from 0.0.0.0/0. The path works, but any source that can route to the target can reach the port; the ALB is no longer the only allowed source.",
    fix:
      "Replace the broad rule with an inbound reference to the ALB security group, then remove the broad rule. Verify the target still passes health checks.",
    checkFirst: [
      "List every inbound rule on the target security group and its source.",
      "Confirm the ALB security group is the only intended source on the service port.",
      "Check whether another security group on the ENI still has a broad rule.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const securityGroupsModel: SimModel = {
  id: "cloud-networking-security-groups",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const v = compute(p);
    const prevAlb = Number(frame.flags.albIngress ?? -1);
    const prevRef = Number(frame.flags.targetRef ?? -1);
    const prevBroad = Number(frame.flags.broadCidr ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const noise = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "blocked-connections" && v.blocked > 0
        ? { ...item, value: Math.max(0, item.value + noise) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.albIngress = v.albIngress ? 1 : 0;
    next.flags.targetRef = v.targetRef ? 1 : 0;
    next.flags.broadCidr = v.broadCidr ? 1 : 0;
    if (prevAlb !== -1 && prevAlb !== next.flags.albIngress) {
      pushEvent(next, {
        id: "alb-ingress-change",
        at: frame.t,
        severity: v.albIngress ? "info" : "warn",
        title: v.albIngress ? "ALB security group allows client traffic" : "ALB security group blocks client traffic",
        detail: v.albIngress
          ? "The ALB listener port now has an inbound allow rule. The target security group is a separate gate."
          : "Clients cannot reach the ALB listener. Check the ALB security group before changing the target security group.",
        nodeId: "alb",
        metricId: "blocked-connections",
      });
    }
    if (prevRef !== -1 && prevRef !== next.flags.targetRef) {
      pushEvent(next, {
        id: "target-reference-change",
        at: frame.t,
        severity: v.targetRef ? "info" : "crit",
        title: v.targetRef ? "Target security group references the ALB" : "Target security group no longer references the ALB",
        detail: v.targetRef
          ? `The target port now allows ${ALB_SG}. The rule follows the ALB network interfaces rather than a subnet CIDR.`
          : "The target has no inbound reference to the ALB security group. The health check and client requests are dropped at the target ENI unless another rule allows the port.",
        nodeId: "target-sg",
        metricId: "unhealthy-targets",
      });
    }
    if (prevBroad !== -1 && prevBroad !== next.flags.broadCidr) {
      pushEvent(next, {
        id: "broad-cidr-change",
        at: frame.t,
        severity: v.broadCidr ? "warn" : "info",
        title: v.broadCidr ? "Target security group opened to 0.0.0.0/0" : "Broad 0.0.0.0/0 target rule removed",
        detail: v.broadCidr
          ? "The target port now allows every IPv4 source. The service may work, but the ALB is no longer the only allowed source."
          : "The broad target rule is gone. The ALB reference must remain in place for the path to keep working.",
        nodeId: "target-sg",
        metricId: "exposure-breadth",
      });
    }
    next.summary = `${formatCount(v.demand)} requests/s; ${v.deliveryRate.toFixed(0)}% delivered; target rule ${
      v.targetRef ? "ALB reference" : v.broadCidr ? "0.0.0.0/0" : "missing"
    }; exposure ${v.exposure}/100.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.albIngress) {
      items.push(
        "The ALB security group has no inbound rule for the listener port. Clients fail before the target is selected, so changing the target security group will not help.",
      );
    } else if (!v.targetAllows) {
      items.push(
        `The target security group has no inbound rule for the target port from ${ALB_SG}. The ALB health check fails and the target is marked unhealthy; the application may still be running.`,
      );
    } else if (v.broadCidr) {
      items.push(
        "The target is reachable, but the security group still allows 0.0.0.0/0 on the service port. The ALB is not the only allowed source; any source that can route to the target can reach it.",
      );
    } else {
      items.push(
        `The path is narrow: the ALB allows clients, and the target allows only ${ALB_SG} on the service port.`,
      );
    }
    items.push(
      "Security groups are stateful. An allowed inbound connection can return a response without a separate outbound rule on the target.",
    );
    items.push(
      "A security group reference follows the referenced group's network interfaces. A CIDR rule follows addresses, so it has to be updated when the ALB subnets or addresses change.",
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
    description: "ALB allows clients, target allows only the ALB security group, and no broad rule is present.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The same narrow path at the top of the illustrative request range.",
    tone: "ok",
    params: defaults({ requestRate: 1_800 }),
  },
  {
    id: "failure",
    label: "Target rule missing",
    description: "The target security group no longer allows the ALB. Health checks and requests fail at the target ENI.",
    tone: "crit",
    params: defaults({ targetRef: 0, requestRate: 900 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The target reference is restored and the broad rule is absent.",
    tone: "ok",
    params: defaults({ requestRate: 800 }),
  },
  {
    id: "cidr-open",
    label: "Open CIDR",
    description: "The target is reachable through 0.0.0.0/0. Traffic works, but the allow list is broader than the ALB.",
    tone: "crit",
    params: defaults({ targetRef: 0, broadCidr: 1, requestRate: 900 }),
  },
];

const experiment: Experiment = {
  id: "predict-broad-target-rule",
  title: "A working path can still be too open",
  simId: "alb-sg-path",
  question:
    "The target security group has no rule that references the ALB security group. It allows 0.0.0.0/0 on the target port. Traffic flows. What is the problem?",
  prediction: {
    options: [
      { id: "no-problem", label: "No problem; the path works, so the rule is fine." },
      { id: "too-broad", label: "The target is reachable from any source that can route to it; the ALB is not the only allowed source." },
      { id: "stateless", label: "Security groups are stateless, so responses will be dropped." },
      { id: "health", label: "The ALB health check cannot pass without a security group reference." },
    ],
    correctOptionId: "too-broad",
    explanation:
      "The path works because 0.0.0.0/0 allows the ALB, but it also allows every other source that can route to the target. A reference to the ALB security group keeps the path working while limiting the source to the ALB's network interfaces.",
  },
  setup: defaults({ albIngress: 1, targetRef: 0, broadCidr: 1, requestRate: 900 }),
  runFor: 15,
  observe: [
    "End-to-end delivery is 100%, so this is not an availability failure.",
    "The target security group shows source 0.0.0.0/0 and the exposure score is 100.",
    "The target and security-group nodes are warning, not healthy.",
    "The target has no outbound rule in this model, but responses still return because the group is stateful.",
    "Replacing the broad rule with the ALB reference keeps delivery at 100% and drops exposure to 0.",
  ],
  explain:
    "A security group is a stateful allow list. The broad rule made the service work, but it also allowed every source that could route to the target. A reference to the ALB security group is narrower: it follows the ALB's network interfaces and does not need the ALB subnet CIDRs. The target still needs no outbound rule for the response because the connection is tracked.",
  fix: defaults({ albIngress: 1, targetRef: 1, broadCidr: 0, requestRate: 900 }),
  debrief:
    "Delivery stays at 100% after the change, but the exposure score drops to zero and the target rule now names the ALB. The lesson is that a working path and a least-privilege path are different checks. In production, replace the CIDR rule and confirm target health in the same change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A security group is a stateful virtual firewall associated with a network interface. It has inbound and outbound rules, and it allows traffic rather than denying it: you can add allow rules but not deny rules. A new security group has no inbound rules and an outbound rule that allows all traffic. When multiple security groups are associated with a resource, their rules are aggregated.",
  },
  {
    type: "p",
    text: "Stateful means the response to an allowed connection is permitted automatically. If you allow an inbound request to the target port, the response can leave without a separate outbound rule. Changes to a security group apply to every resource associated with it. Security groups are evaluated at the network interface, while network ACLs are stateless and evaluated at the subnet.",
  },
  {
    type: "p",
    text: "For an ALB, the usual pattern is two groups. The ALB security group allows clients on the listener port. The target security group allows the target port and the health-check port only from the ALB security group. Referencing the ALB group is safer than listing the ALB subnet CIDRs: the reference follows the ALB's network interfaces, and it counts as one rule regardless of how many addresses the ALB uses.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB security group, ALB, target security group, target network interface, application. The return path is handled by connection tracking. The ALB health check uses the target security group too, so a rule that blocks client traffic usually blocks health checks as well, and the target is removed from service.",
  },
  {
    type: "table",
    headers: ["Rule", "Source", "Port", "Result"],
    rows: [
      ["ALB inbound", "Client CIDR, often 0.0.0.0/0 for a public ALB", "Listener, for example 443", "Clients can reach the load balancer."],
      ["Target inbound", "ALB security group reference", "Target and health-check port", "Only the ALB network interfaces can reach the target."],
      ["Target inbound", "0.0.0.0/0", "Target port", "Any routable source can reach the target; the ALB is not the only source."],
      ["Target outbound", "None", "Not required for the response", "The response to an allowed inbound connection still returns because the group is stateful."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Security group",
    rightTitle: "Network ACL",
    rows: [
      { label: "Scope", left: "Network interface.", right: "Subnet." },
      { label: "State", left: "Stateful; return traffic is automatic.", right: "Stateless; both directions need rules." },
      { label: "Rule types", left: "Allow only.", right: "Allow and deny." },
      { label: "Evaluation", left: "All rules are evaluated.", right: "Rules are evaluated in order by number." },
      { label: "Typical use", left: "Service-to-service and client access.", right: "Coarse subnet guardrail and ephemeral-port control." },
    ],
  },
  {
    type: "p",
    text: "The failure this module targets is a target group that never receives the request. The ALB security group is open, the listener is healthy, and the target application is running, but the target security group does not allow the ALB. The health check fails first, so the target is marked unhealthy before a user sees a timeout. If every target in every enabled Availability Zone is unhealthy, the ALB can fail open and route to all targets regardless of health, but the security group still blocks the traffic. Health status alone does not prove reachability.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Two security-group controls: the ALB inbound rule and the target inbound rule.",
      "A broad 0.0.0.0/0 target rule that makes the path work but raises the exposure score.",
      "Delivery, blocked requests, and targets failing health checks.",
      "A topology that separates the client-to-ALB gate from the ALB-to-target gate.",
      "A request-rate control that changes volume, not the allow-list decision.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read both security groups before touching a slider. Remove the target reference and watch the target health check fail. Restore it, then replace the reference with the broad CIDR rule: delivery stays at 100%, but the exposure score and the node state change. Run the guided experiment before revealing its explanation.",
  },
  { type: "sim", simId: "alb-sg-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Removing the target reference did not change the ALB security group. The ALB still accepted clients, but its health check and requests were dropped at the target network interface. The target was marked unhealthy, and end-to-end delivery fell to zero.",
  },
  {
    type: "p",
    text: "Replacing the reference with 0.0.0.0/0 restored delivery. The path worked, but the target port allowed every source that could route to it, and the exposure score rose to 100. The target node stayed in a warning state even though requests succeeded, because availability and least privilege are different checks.",
  },
  {
    type: "p",
    text: "The target had no outbound rule in the model, and responses still returned. That is the stateful behavior: the connection was allowed inbound, so the reply is tracked and permitted outbound. A network ACL would not behave the same way.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Target health: describe-target-health returns unhealthy with a reason such as Target.FailedHealthChecks or Target.Timeout. The application can still be running.",
      "Security groups: the target group's inbound rules do not include the ALB security group on the target or health-check port.",
      "ALB metrics: UnhealthyHostCount rises, and requests may fail at the ALB before reaching the target. Check HealthyHostCount too.",
      "VPC Flow Logs: REJECT records at the target ENI show the security group or network ACL drop; a missing record is evidence about the log point, not proof of the drop location.",
      "Reachability Analyzer: static configuration analysis that returns the blocking component, including a security group rule.",
      "ALB fail-open: if every target in every enabled AZ is unhealthy, the ALB routes to all targets regardless of health. The security group can still block the traffic, so fail-open is not a fix.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the target security group's inbound rules with the ALB security group ID, then check the target port and the health-check port. Confirm the ALB security group's outbound rule toward the target. Do not open the target to 0.0.0.0/0 just to make the health check pass.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the ALB security group and the target security group. Record the listener port, target port, and health-check port.",
      "Add an inbound rule on the target security group whose source is the ALB security group, for the target and health-check ports.",
      "Confirm the ALB security group's outbound rule allows the target security group. The default outbound rule allows all traffic; a restricted group may not.",
      "Remove the broad 0.0.0.0/0 target rule after the reference is in place. Do not leave both.",
      "Check the target group health and the health-check path. Re-check after the rule change.",
      "Test a real request through the ALB and confirm the response. Use flow logs or Reachability Analyzer to narrow a remaining blocker.",
      "Record the rule change and add a check that alerts on broad target rules.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A security group reference is narrower and follows the ALB's network interfaces, but it couples the two groups: deleting or replacing the ALB group breaks the rule.",
      "A CIDR rule is simple and works across accounts or VPCs where a reference is not supported, but it must be updated when addresses change and it is easier to make too broad.",
      "A broad rule can make an incident disappear quickly, but it also removes the ALB as the only allowed source. Treat it as a temporary, reviewed change.",
      "Security groups are stateful and convenient for service access; network ACLs are stateless and useful as a coarse subnet guardrail, but they require ephemeral-port rules in both directions.",
      "Health checks are a strong signal, but fail-open behavior means a fully unhealthy target group can still receive traffic. Verify the security group, not only the health status.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "alb-target-rule",
    question:
      "A new service cannot be reached from the load balancer, but the target application is running. Which security group rule do you check first?",
    difficulty: 2,
    hints: [
      "There are two security groups: the ALB and the target.",
      "The target port and health-check port are separate from the listener port.",
    ],
    answer:
      "I would check the target security group's inbound rule for the target port and the health-check port. It should allow the ALB security group as the source, not a broad CIDR. Then I would check the ALB security group's outbound rule toward the target. The listener port on the ALB can be open while the target port is closed, so the ALB accepts the connection and then fails to reach the target. I would confirm with describe-target-health and the ALB's UnhealthyHostCount, then test a real request after the rule change.",
    followUps: [
      "Why does the health check fail before the user request?",
      "What if the target group is healthy but requests still fail?",
      "How would you verify the rule change?",
    ],
    redFlags: [
      "Opens the target to 0.0.0.0/0.",
      "Checks only the ALB listener rule.",
      "Assumes the application is down.",
    ],
    rubric: [
      "Checks the target security group first.",
      "Names the ALB security group as the source.",
      "Checks both target and health-check ports.",
      "Uses target health and a real request to verify.",
    ],
  },
  {
    id: "stateful-return",
    question:
      "The target security group has no outbound rules. Does the response to an allowed inbound request return? Why?",
    difficulty: 2,
    hints: [
      "Security groups are stateful.",
      "Connection tracking remembers the flow.",
    ],
    answer:
      "Yes. Security groups are stateful: when an inbound request is allowed, the response traffic for that connection is allowed out regardless of the outbound rules. The connection is tracked, so the target does not need a separate outbound rule for the reply. If the target initiates a new outbound connection to a dependency, that direction needs its own outbound rule. A network ACL is different: it is stateless, so both directions and the ephemeral ports need explicit rules.",
    followUps: [
      "When would the target need an outbound rule?",
      "How does a network ACL change the answer?",
      "What happens to the tracking entry when the connection closes?",
    ],
    redFlags: [
      "Says the response is blocked without an outbound rule.",
      "Confuses security groups with network ACLs.",
      "Adds 0.0.0.0/0 outbound to fix the response.",
    ],
    rubric: [
      "States that security groups are stateful.",
      "Explains connection tracking.",
      "Separates response traffic from a new outbound connection.",
      "Contrasts with stateless network ACLs.",
    ],
  },
  {
    id: "reference-vs-cidr",
    question:
      "Why is a security group reference safer than a CIDR range for allowing the ALB to reach a target?",
    difficulty: 2,
    hints: [
      "The reference follows the ALB network interfaces.",
      "CIDR rules need maintenance when addresses change.",
    ],
    answer:
      "A reference allows traffic from the network interfaces associated with the referenced security group, so it follows the ALB as its nodes or addresses change. A CIDR rule allows an address range, which may include sources that are not the ALB, and it must be updated when the ALB's subnets or addresses change. The reference is also one rule regardless of how many addresses the ALB uses. It does couple the two groups: deleting the ALB group or changing its association can break the rule, so the relationship should be documented and tested.",
    followUps: [
      "When would a CIDR rule still be necessary?",
      "What happens if the referenced group is deleted?",
      "Does the reference work across VPC peering or a transit gateway?",
    ],
    redFlags: [
      "Says a CIDR rule is always narrower.",
      "Ignores the coupling between groups.",
      "Opens the port to the VPC CIDR and calls it least privilege.",
    ],
    rubric: [
      "Explains that the reference follows ENIs.",
      "Contrasts with address-based maintenance.",
      "Notes the coupling and lifecycle risk.",
      "Names a case where CIDR is still needed.",
    ],
  },
  {
    id: "debug-sg-drop",
    question:
      "How do you prove that a security group, rather than a route or a network ACL, is dropping the traffic?",
    difficulty: 3,
    hints: [
      "Check the observation point and the direction.",
      "Flow logs show ACCEPT and REJECT at the ENI.",
    ],
    answer:
      "I would use VPC Flow Logs at the source and destination ENIs and compare direction. A REJECT record at the target ENI points at the security group or network ACL on that ENI; an ACCEPT on the source but no record on the destination suggests a routing or middlebox problem. I would also read the security group rules and the network ACL rules for both directions, and use Reachability Analyzer to identify the blocking component in the configuration. A packet capture or a test from the same source subnet can confirm the live path. No single signal proves it; I would correlate the configuration, the flow record, and a real request.",
    followUps: [
      "What does an ACCEPT record prove?",
      "What does a missing record prove?",
      "How would a network ACL show up differently?",
    ],
    redFlags: [
      "Treats one flow log record as the whole path.",
      "Changes security groups without reading the ACL.",
      "Ignores the direction of the flow.",
    ],
    rubric: [
      "Uses flow logs at both ends.",
      "Distinguishes security group from network ACL.",
      "Uses Reachability Analyzer for configuration.",
      "Confirms with a real request.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "ALB and target security groups have an owner and a documented rule set.",
      "Target rules reference the ALB security group rather than broad CIDRs.",
      "Health-check ports and target ports are included in the rule review.",
      "Broad 0.0.0.0/0 rules have an exception record and an expiry.",
      "Target health and narrow-rule checks are part of the deployment test.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the target security group's inbound rule for the ALB group and the target port.",
      "Check the health-check port and path, not only the listener.",
      "Check the ALB security group's outbound rule toward the target.",
      "Read describe-target-health and the ALB's healthy host count.",
      "Use flow logs or Reachability Analyzer to confirm the drop point.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove temporary broad rules and restore the reference.",
      "Re-test target health and a real request through the ALB.",
      "Add a check for broad rules and missing references.",
      "Record whether the failure was the ALB rule, target rule, health check, or a network ACL.",
    ],
  },
];

const references = [
  {
    title: "Control traffic to your AWS resources using security groups",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Stateful behavior, default rules, and the security group basics.",
  },
  {
    title: "Security group rules",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/security-group-rules.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Allow-only rules, references, rule evaluation, and the ALB-to-target example.",
  },
  {
    title: "Security groups for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The ALB and target rules for listener and health-check ports, including the target group reference.",
  },
  {
    title: "Health checks for Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target health states, reason codes, and the fail-open behavior when every target is unhealthy.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-sg-path": {
      model: securityGroupsModel,
      presets,
      instructions:
        "Start healthy, remove the target reference, then restore it and compare the broad CIDR rule. Watch delivery, target health, and the exposure score together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The exposure score is a teaching value, not an AWS metric; security group and health-check behavior follow AWS semantics.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-target-groups",
    "cloud-networking-nacls",
    "cloud-networking-flow-logs",
    "cloud-networking-reachability-analyzer",
    "cloud-networking-route-tables",
  ],
};
