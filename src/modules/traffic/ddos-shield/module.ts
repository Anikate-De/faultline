import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const LEGITIMATE_GBPS = 2;

const params: ParamSpec[] = [
  {
    id: "attackGbps",
    label: "Attack volume",
    min: 0,
    max: 1_000,
    step: 10,
    value: 0,
    unit: " Gbps",
    group: "Attack",
    help: "Illustrative volumetric attack traffic arriving at the edge. The production scenario's 40x jump is a teaching multiplier, not a measured attack.",
    format: "number",
  },
  {
    id: "mitigationEnabled",
    label: "DDoS mitigation (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Mitigation",
    help: "0 lets the attack pass to the origin. 1 filters attack traffic at the edge up to the illustrative mitigation capacity.",
    format: "count",
  },
  {
    id: "mitigationCapacity",
    label: "Mitigation capacity (illustrative)",
    min: 20,
    max: 1_000,
    step: 20,
    value: 200,
    unit: " Gbps",
    group: "Mitigation",
    help: "Teaching value for the edge or scrubbing capacity available to this workload. AWS documents more than 100 Tbps of mitigation capacity across all Regions and edge locations; it does not publish a per-customer scrubbing number.",
    format: "number",
  },
  {
    id: "originCapacity",
    label: "Origin ingress capacity",
    min: 1,
    max: 40,
    step: 1,
    value: 10,
    unit: " Gbps",
    group: "Origin",
    help: "Illustrative capacity of the load balancer and origin path. The origin absorbs only what the mitigation layer lets through, plus legitimate traffic.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

interface Computed {
  attack: number;
  mitigation: boolean;
  mitigationCapacity: number;
  originCapacity: number;
  attackAtOrigin: number;
  totalAtOrigin: number;
  delivered: number;
  legitDelivered: number;
  legitDrop: number;
  originUtil: number;
  mitigationLoad: number;
  legit: number;
}

function compute(p: Params): Computed {
  const attack = Math.max(0, num(p, "attackGbps", 0));
  const mitigation = num(p, "mitigationEnabled", 1) >= 0.5;
  const mitigationCapacity = Math.max(20, num(p, "mitigationCapacity", 200));
  const originCapacity = Math.max(1, num(p, "originCapacity", 10));
  const attackAtOrigin = mitigation ? Math.max(0, attack - mitigationCapacity) : attack;
  const totalAtOrigin = LEGITIMATE_GBPS + attackAtOrigin;
  const delivered = Math.min(totalAtOrigin, originCapacity);
  const legitDelivered = totalAtOrigin > 0 ? Math.min(LEGITIMATE_GBPS, (delivered * LEGITIMATE_GBPS) / totalAtOrigin) : 0;
  return {
    attack,
    mitigation,
    mitigationCapacity,
    originCapacity,
    attackAtOrigin,
    totalAtOrigin,
    delivered,
    legitDelivered,
    legitDrop: clamp(100 * (1 - legitDelivered / LEGITIMATE_GBPS), 0, 100),
    originUtil: Math.min(100, (totalAtOrigin / originCapacity) * 100),
    mitigationLoad: mitigation ? Math.min(100, (attack / mitigationCapacity) * 100) : 0,
    legit: LEGITIMATE_GBPS,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const c = compute(p);
  const legitHealth: Health = c.legitDrop >= 5 ? "crit" : c.legitDrop >= 1 ? "warn" : "ok";
  const attackerHealth: Health = c.attack === 0 ? "ok" : !c.mitigation || c.attackAtOrigin > 0 ? "crit" : "ok";
  const edgeHealth: Health = !c.mitigation && c.attack > 0 ? "crit" : c.mitigationLoad >= 95 ? "crit" : c.mitigationLoad >= 80 ? "warn" : "ok";
  const originHealth: Health = c.originUtil >= 95 ? "crit" : c.originUtil >= 80 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "users",
        label: "Legitimate users",
        kind: "client",
        health: legitHealth,
        sublabel: `${LEGITIMATE_GBPS} Gbps of real traffic`,
        detail:
          "Legitimate traffic is a small share of the ingress during a volumetric attack. It succeeds only if the attack is filtered before the origin's capacity is consumed.",
        meta: { view: "flow" },
      },
      {
        id: "botnet",
        label: "Attack sources",
        kind: "external",
        health: attackerHealth,
        sublabel: `${formatCount(c.attack)} Gbps offered`,
        detail: c.attack === 0
          ? "No attack traffic in this scenario."
          : `The botnet offers ${formatCount(c.attack)} Gbps. ${c.mitigation ? `${formatCount(c.attackAtOrigin)} Gbps pass the illustrative mitigation layer.` : "Mitigation is off, so all of it heads for the origin."}`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge / scrubbing",
        kind: "cdn",
        health: edgeHealth,
        utilization: clamp(c.mitigationLoad / 100),
        sublabel: c.mitigation ? `${formatCount(c.mitigationCapacity)} Gbps capacity` : "mitigation off",
        detail: c.mitigation
          ? `The edge filters the attack up to ${formatCount(c.mitigationCapacity)} Gbps. ${c.attackAtOrigin > 0 ? `${formatCount(c.attackAtOrigin)} Gbps overflow to the origin.` : "No attack traffic reaches the origin in this model."}`
          : "The attack is not filtered. The origin receives the full attack volume plus legitimate traffic.",
        meta: { view: "flow" },
      },
      {
        id: "origin",
        label: "Load balancer / origin",
        kind: "lb",
        health: originHealth,
        utilization: clamp(c.originUtil / 100),
        sublabel: `${formatCount(c.totalAtOrigin)} Gbps ingress · ${formatCount(c.originCapacity)} Gbps`,
        detail:
          c.originUtil >= 95
            ? `The origin is at ${c.originUtil.toFixed(0)}% of its ingress capacity. It drops traffic before the application can respond.`
            : `The origin is at ${c.originUtil.toFixed(0)}% of its ingress capacity.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Application",
        kind: "service",
        health: legitHealth,
        utilization: clamp(c.legitDrop / 100),
        sublabel: `${c.legitDrop.toFixed(0)}% of legitimate traffic dropped`,
        detail:
          "The application sees only what the origin delivers. A volumetric attack can starve it without ever reaching the application code.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("users-edge", "users", "edge", 1, legitHealth),
      edge("botnet-edge", "botnet", "edge", clamp(c.attack / 1_000), attackerHealth),
      edge("edge-origin", "edge", "origin", clamp(c.totalAtOrigin / Math.max(1, c.originCapacity)), originHealth),
      edge("origin-service", "origin", "service", clamp(c.delivered / Math.max(1, c.originCapacity)), legitHealth),
    ],
    metrics: [
      metric("attack-at-origin", "Attack traffic reaching origin", c.attackAtOrigin, " Gbps", 1, 10, "number"),
      metric("origin-utilization", "Origin ingress utilization", c.originUtil, "%", 80, 95, "percent"),
      metric("legit-drop", "Legitimate traffic dropped", c.legitDrop, "%", 1, 5, "percent"),
      metric("mitigation-load", "Mitigation capacity used", c.mitigationLoad, "%", 80, 95, "percent"),
      metric("attack-volume", "Attack volume offered", c.attack, " Gbps", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.attack === 0
      ? `No attack. ${formatCount(LEGITIMATE_GBPS)} Gbps legitimate traffic; origin at ${c.originUtil.toFixed(0)}%.`
      : `${formatCount(c.attack)} Gbps attack, ${formatCount(c.attackAtOrigin)} Gbps reach the origin; ${c.legitDrop.toFixed(0)}% of legitimate traffic dropped.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "attack-at-origin",
    metricId: "attack-at-origin",
    warn: 1,
    crit: 10,
    title: "Attack traffic is reaching the origin",
    cause:
      "Mitigation is off or the attack exceeds the illustrative mitigation capacity. The origin's ingress is now shared between attack and legitimate traffic.",
    fix:
      "Enable mitigation, add capacity at the edge, or shift the attack to a larger scrubbing path. Adding origin capacity alone is not a defense against a volumetric flood.",
    checkFirst: [
      "Confirm whether mitigation is enabled for the protected resource.",
      "Compare attack volume with the mitigation capacity.",
      "Check whether the attack is L3/L4 volumetric or an L7 request flood.",
    ],
  },
  {
    id: "origin-utilization",
    metricId: "origin-utilization",
    warn: 80,
    crit: 95,
    title: "Origin ingress is saturated",
    cause:
      "The traffic that survived mitigation, plus legitimate traffic, is close to the origin's ingress capacity. The origin drops packets before the application can respond.",
    fix:
      "Filter more at the edge, reduce the attack surface, or add capacity upstream of the origin. Do not rely on application autoscaling for a bandwidth flood.",
    checkFirst: [
      "Compare origin ingress with its provisioned capacity.",
      "Check whether the load balancer is dropping connections or the application is slow.",
      "Check the attack volume at the edge, not only at the origin.",
    ],
  },
  {
    id: "legit-drop",
    metricId: "legit-drop",
    warn: 1,
    crit: 5,
    title: "Legitimate users are being dropped",
    cause:
      "The origin is full of attack traffic, or the mitigation rule is dropping valid requests. A volumetric attack consumes capacity before the application can distinguish users.",
    fix:
      "Move filtering closer to the edge, add capacity, and verify that the mitigation rules are not matching legitimate traffic. For L7 attacks, tune WAF and rate rules with a false-positive budget.",
    checkFirst: [
      "Separate attack traffic from legitimate traffic in edge and origin telemetry.",
      "Check whether the drop began when mitigation was enabled.",
      "Check the false-positive rate of WAF and rate rules.",
    ],
  },
  {
    id: "mitigation-load",
    metricId: "mitigation-load",
    warn: 80,
    crit: 95,
    title: "Mitigation capacity is nearly exhausted",
    cause:
      "The attack is close to the illustrative capacity of the edge or scrubbing layer. A larger attack can overflow to the origin even with mitigation enabled.",
    fix:
      "Add mitigation capacity, distribute the entry point across more sites, or engage the provider's DDoS response team. Capacity is finite; mitigation is not a magic unlimited absorber.",
    checkFirst: [
      "Compare attack volume with the mitigation capacity, not the origin capacity.",
      "Check whether the attack is concentrated on one site or one prefix.",
      "Check the provider's current mitigation status and any scrubbing diversion.",
    ],
  },
];

export const ddosShieldModel: SimModel = {
  id: "traffic-ddos-shield",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    for (const item of frame.metrics) frame.series[item.id] = [item.value];
    return frame;
  },
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const c = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([id, values]) => [id, [...values]]));
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (c.attack > 0 && frame.flags.attackLogged !== 1) {
      pushEvent(next, {
        id: "ddos-detected",
        severity: c.attackAtOrigin > 0 ? "crit" : "warn",
        title: "DDoS traffic detected at the edge",
        detail: `${formatCount(c.attack)} Gbps offered. ${c.mitigation ? `${formatCount(c.mitigationCapacity)} Gbps of mitigation capacity is enabled.` : "Mitigation is disabled."}`,
        nodeId: "edge",
        metricId: "attack-volume",
      });
      next.flags.attackLogged = 1;
    }
    if (c.attack === 0) next.flags.attackLogged = 0;
    if (c.attackAtOrigin > 0 && frame.flags.overflowLogged !== 1) {
      pushEvent(next, {
        id: "mitigation-overflow",
        severity: "crit",
        title: "Attack traffic overflowed mitigation",
        detail: `${formatCount(c.attackAtOrigin)} Gbps reach the origin. ${c.mitigation ? "The attack exceeds the illustrative mitigation capacity." : "Mitigation is disabled."}`,
        nodeId: "origin",
        metricId: "attack-at-origin",
      });
      next.flags.overflowLogged = 1;
    }
    if (c.attackAtOrigin === 0) next.flags.overflowLogged = 0;
    if (c.attack > 0 && c.mitigation && c.attackAtOrigin === 0 && frame.flags.absorbedLogged !== 1) {
      pushEvent(next, {
        id: "attack-absorbed",
        severity: "info",
        title: "Attack absorbed before the origin",
        detail: `${formatCount(c.attack)} Gbps is filtered at the edge. The origin sees only legitimate traffic. Verify the mitigation rule is not dropping valid users.`,
        nodeId: "edge",
        metricId: "attack-at-origin",
      });
      next.flags.absorbedLogged = 1;
    }
    if (c.attackAtOrigin > 0 || c.attack === 0) next.flags.absorbedLogged = 0;
    if (c.attack === 0 && frame.flags.attackLogged === 1) {
      pushEvent(next, {
        id: "attack-cleared",
        severity: "info",
        title: "Attack traffic cleared",
        detail: "No attack volume is offered. Verify origin latency and connection state before reducing mitigation.",
        nodeId: "origin",
      });
      next.flags.attackLogged = 0;
    }
    next.metrics = next.metrics.map((item) => ({ ...item }));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    if (c.attack === 0) {
      items.push(`No attack is active. ${formatCount(LEGITIMATE_GBPS)} Gbps of legitimate traffic uses ${c.originUtil.toFixed(0)}% of the origin ingress.`);
    } else if (c.mitigation && c.attackAtOrigin === 0) {
      items.push(`${formatCount(c.attack)} Gbps is filtered at the edge; the origin sees ${formatCount(LEGITIMATE_GBPS)} Gbps of legitimate traffic and ${c.legitDrop.toFixed(0)}% is dropped.`);
    } else {
      items.push(`${formatCount(c.attackAtOrigin)} Gbps of attack traffic reaches the origin. Legitimate traffic is ${c.legitDrop.toFixed(0)}% dropped and the origin is at ${c.originUtil.toFixed(0)}% ingress utilization.`);
    }
    items.push(
      c.mitigation
        ? `Mitigation is using ${c.mitigationLoad.toFixed(0)}% of its ${formatCount(c.mitigationCapacity)} Gbps illustrative capacity.`
        : "Mitigation is disabled, so the origin is the first place the attack is limited. That is not a defense; it is a bottleneck.",
    );
    items.push(
      "Volumetric and protocol attacks are absorbed or filtered before the application. An L7 request flood looks like valid traffic and needs WAF, rate limits, and bot controls; a big origin does not stop it.",
    );
    if (c.attack > 0 && c.attackAtOrigin > 0) {
      items.push("The overflow is a capacity problem at the mitigation layer. Adding origin capacity may raise the ceiling, but the attack can grow to fill it.");
    }
    items.push(
      "AWS Shield Standard is automatic. Shield Advanced adds enhanced protection, visibility, response team access, and cost protection for protected resources. Neither replaces capacity planning or application-layer controls.",
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
    description: "No attack; 2 Gbps of legitimate traffic uses 20% of a 10 Gbps origin.",
    tone: "ok",
    params: defaults({ attackGbps: 0, mitigationEnabled: 1, mitigationCapacity: 200, originCapacity: 10 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 40 Gbps attack uses 80% of a 50 Gbps mitigation layer; the origin stays clean.",
    tone: "warn",
    params: defaults({ attackGbps: 40, mitigationEnabled: 1, mitigationCapacity: 50, originCapacity: 10 }),
  },
  {
    id: "failure",
    label: "Mitigation off",
    description: "A 120 Gbps attack goes straight to a 10 Gbps origin. The ALB drops almost all legitimate traffic.",
    tone: "crit",
    params: defaults({ attackGbps: 120, mitigationEnabled: 0, mitigationCapacity: 200, originCapacity: 10 }),
  },
  {
    id: "overflow",
    label: "Scrubber overflow",
    description: "Mitigation is on, but a 600 Gbps attack exceeds 200 Gbps of capacity; 400 Gbps reach the origin.",
    tone: "crit",
    params: defaults({ attackGbps: 600, mitigationEnabled: 1, mitigationCapacity: 200, originCapacity: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Mitigation is on with 400 Gbps capacity and a 300 Gbps attack; the origin sees only legitimate traffic.",
    tone: "ok",
    params: defaults({ attackGbps: 300, mitigationEnabled: 1, mitigationCapacity: 400, originCapacity: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-absorption-point",
  title: "Predict where the attack should be absorbed",
  simId: "ddos-shield",
  question:
    "Inbound traffic jumps to 120 Gbps against a 10 Gbps origin. Where should the attack be absorbed?",
  prediction: {
    options: [
      { id: "edge", label: "At the edge or scrubbing layer, before the origin's ingress." },
      { id: "origin", label: "At the origin, by adding larger load balancer nodes." },
      { id: "app", label: "In the application, by autoscaling the service." },
      { id: "dns", label: "In DNS, by lowering the record TTL." },
    ],
    correctOptionId: "edge",
    explanation:
      "A volumetric attack consumes network and connection capacity before the application runs. The origin cannot autoscale a pipe or a SYN backlog fast enough to absorb a 120 Gbps flood. The attack has to be filtered or absorbed upstream, at the edge or scrubbing layer, so the origin sees mostly legitimate traffic.",
  },
  setup: defaults({ attackGbps: 120, mitigationEnabled: 0, mitigationCapacity: 200, originCapacity: 10 }),
  runFor: 20,
  observe: [
    "All 120 Gbps reaches the origin, which has only 10 Gbps of ingress.",
    "Origin ingress is at 100% and about 92% of legitimate traffic is dropped.",
    "The application is starved even though its code and CPU are fine.",
    "The edge mitigation layer is idle because it is disabled.",
  ],
  explain:
    "The origin is a bottleneck, not a defense. When the attack reaches it, the load balancer and the network path drop packets before the application can respond. Enabling mitigation at the edge filters the attack and leaves the origin with the legitimate 2 Gbps. For an application-layer flood, the same logic applies at the WAF and rate-limit layer, not at the origin's CPU.",
  fix: defaults({ attackGbps: 120, mitigationEnabled: 1, mitigationCapacity: 200, originCapacity: 10 }),
  debrief:
    "With mitigation on, the edge absorbs the 120 Gbps attack and the origin returns to 20% ingress utilization with no legitimate drops. The remaining risk is the mitigation capacity itself: a larger attack can overflow it, and an L7 flood can pass through as valid requests. Test both, and keep the origin's own connection limits as a backstop.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A distributed denial-of-service (DDoS) attack uses many sources to exhaust a resource. A volumetric attack floods network capacity at layer 3. A protocol attack such as a TCP SYN flood exhausts connection state at layer 4. An application-layer attack sends requests that look valid but consume worker time, database connections, or business logic at layer 7. The layer determines what absorbs the attack.",
  },
  {
    type: "p",
    text: "AWS Shield Standard is automatic and included for AWS customers. It protects against common network and transport layer attacks. Shield Advanced is an optional subscription with enhanced detection and mitigation, visibility, access to the Shield Response Team, cost protection for scaling during an attack, and AWS WAF benefits for protected resources. AWS applies mitigation at the network border and at edge locations; its documentation describes more than 100 Tbps of mitigation capacity across all Regions and edge locations, and says it does not reroute traffic to external or remote scrubbing centers.",
  },
  {
    type: "p",
    text: "Scrubbing is the general idea of filtering attack traffic before it reaches the origin. Some providers divert traffic through scrubbing centers; AWS describes inline mitigation at its ingress points. Cloudflare mitigates on its global anycast network. The names differ, but the placement is the same: upstream of the resource that must keep serving.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is attack sources and legitimate users, then the provider edge, then the load balancer, then the application. Anycast can spread the attack across sites, but distribution is not filtering. A scrubbing layer filters, and a WAF or rate limiter handles requests that look valid. The origin is the last place to absorb anything; by then the attack has already consumed the capacity you were trying to protect.",
  },
  {
    type: "table",
    headers: ["Layer", "Example", "What it exhausts", "First control"],
    rows: [
      ["L3 volumetric", "UDP or ICMP flood", "Network bandwidth and link capacity", "Provider edge absorption, anycast distribution"],
      ["L4 protocol", "TCP SYN flood", "Connection state, SYN backlog, conntrack", "SYN cookies, connection limits, edge mitigation"],
      ["L7 application", "HTTP request flood", "Workers, database connections, CPU", "WAF rules, rate limits, bot controls, caching"],
    ],
  },
  {
    type: "p",
    text: "A large origin does not stop a volumetric attack. Autoscaling application instances does not widen the network pipe, and a bigger load balancer does not add upstream capacity. The defense has to be in front of the resource, and it has to be sized for the attack you expect.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Attack volume at the edge, mitigation capacity used, and attack traffic that reaches the origin.",
      "Origin ingress utilization and the share of legitimate traffic dropped.",
      "The difference between mitigation off and mitigation on at the same attack volume.",
      "An overflow case where mitigation is on but the attack exceeds its capacity.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Mitigation off: the 120 Gbps attack reaches the 10 Gbps origin and legitimate traffic collapses. Run the experiment, then enable mitigation in the fix. Apply Scrubber overflow to see that mitigation capacity is finite, not unlimited.",
  },
  {
    type: "p",
    text: "The attack volumes and capacities in this lab are teaching values. The production question's 40x jump is a scenario, not a measured attack. What transfers is the placement: absorb and filter before the origin, then verify what still gets through.",
  },
  { type: "sim", simId: "ddos-shield" },
  { type: "experiment", experimentId: "predict-absorption-point" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With mitigation off, the full attack reached the origin. The origin's ingress filled, it dropped packets, and legitimate users failed even though the application was healthy. Turning mitigation on filtered the attack at the edge and the origin returned to its normal load.",
  },
  {
    type: "p",
    text: "The overflow preset showed the limit of that fix. Mitigation capacity is finite. When the attack exceeded it, the excess reached the origin and the same failure returned. The control is necessary but it still has to be sized, monitored, and backed by application-layer controls for request floods.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Shield Advanced event details and CloudWatch metrics such as DDoSDetected and the attack bits, packets, and requests per second.",
      "Load balancer metrics: RejectedConnectionCount, ActiveConnectionCount, NewConnectionCount, and ELB 5xx, split by Availability Zone.",
      "Origin ingress and egress, interface drops, retransmits, and SYN backlog or conntrack usage for protocol attacks.",
      "WAF and rate-limit metrics: blocked requests, allowed requests, and false positives on legitimate paths.",
      "Application latency and error rate for the traffic that actually reaches the service.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Separate attack traffic from a legitimate flash crowd before changing rules. Confirm whether the attack is L3/L4 or L7, then check whether mitigation is actually enabled for the protected resource. If the origin is full, the filtering is too late or too small.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify the attack by layer and by the resource it is exhausting.",
      "Confirm the protected resource and that mitigation is enabled.",
      "Shift filtering upstream: edge mitigation for volumetric traffic, WAF and rate limits for L7.",
      "Add capacity at the mitigation layer if the attack exceeds it; do not start at the origin.",
      "Protect the origin's connection state with limits and SYN cookies as a backstop.",
      "Verify legitimate traffic still succeeds, then tune false positives and cost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Always-on edge mitigation adds a dependency and a cost, but it is the only place a volumetric attack can be absorbed.",
      "Shield Advanced adds visibility, response support, and cost protection, but it does not make origin capacity unlimited.",
      "Aggressive WAF and rate rules stop L7 floods but can block real users; measure false positives.",
      "Anycast distributes an attack but can still concentrate it on one site; per-site capacity matters.",
      "Origin autoscaling handles legitimate growth, not a bandwidth flood; it can add cost without restoring service.",
      "Lowering DNS TTL changes how fast clients move, not how much attack traffic the edge can absorb.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "attack-or-crowd",
    question:
      "Traffic jumps 40x and the load balancer is dropping connections. How do you tell an attack from a legitimate flash crowd, and what do you do first?",
    difficulty: 3,
    hints: [
      "Look at the traffic mix and the resource being exhausted.",
      "The first control depends on the layer.",
    ],
    answer:
      "I would look at the shape of the traffic before changing capacity: source and ASN distribution, request paths, user agents, request rate per client, geography, and whether the traffic completes normal sessions. A flash crowd is concentrated on a few real pages and comes from many real users; an attack often repeats one path, uses a narrow set of sources, or sends malformed or half-open connections. I would check edge and Shield metrics, plus the origin's ingress, connection state, and error rate. For a volumetric or SYN flood I would enable or verify edge mitigation first; for an L7 request flood I would use WAF and rate limits with a false-positive budget. I would not start by adding origin capacity, because a bandwidth flood will consume it.",
    followUps: [
      "Which metric tells you the attack is L7 rather than L3/L4?",
      "What would you do if mitigation is already on and the origin is still full?",
      "How do you protect legitimate users during the response?",
    ],
    redFlags: [
      "Starts by autoscaling the application.",
      "Blocks all traffic without measuring false positives.",
      "Treats every traffic spike as an attack.",
    ],
    rubric: [
      "Separates attack from flash crowd with evidence.",
      "Classifies the attack layer.",
      "Chooses an upstream control.",
      "Protects legitimate traffic and measures false positives.",
    ],
  },
  {
    id: "shield-levels",
    question:
      "What does Shield Advanced add over Shield Standard, and what does it not solve?",
    difficulty: 3,
    hints: [
      "Standard is automatic; Advanced is a subscription.",
      "Mitigation capacity is not the same as application capacity.",
    ],
    answer:
      "Shield Standard is automatic and covers common network and transport layer attacks for AWS customers. Shield Advanced adds enhanced detection and mitigation, visibility into events, access to the Shield Response Team, cost protection for scaling during an attack, and AWS WAF benefits for protected resources, including automatic application-layer mitigation when enabled. It does not make the origin infinitely scalable, and it does not replace WAF rules or application design for an L7 flood. It also protects the resources you associate with it; an unprotected resource does not get the same treatment. I would still size the origin, tune rate limits, and test the runbook.",
    followUps: [
      "When would you enable automatic application-layer mitigation?",
      "What does cost protection actually cover?",
      "How does Shield interact with a multi-account organization?",
    ],
    redFlags: [
      "Says Shield Advanced absorbs any size attack.",
      "Confuses cost protection with outage prevention.",
      "Assumes every resource is protected automatically.",
    ],
    rubric: [
      "Distinguishes Standard from Advanced accurately.",
      "Names visibility, response, and cost protection.",
      "States the origin and L7 limits.",
      "Mentions resource association and testing.",
    ],
  },
  {
    id: "waf-vs-shield",
    question:
      "Where does AWS WAF fit relative to Shield, and which one stops a credential-stuffing wave?",
    difficulty: 3,
    hints: [
      "One works on packets and connections; the other inspects requests.",
      "Credential stuffing uses valid-looking login requests.",
    ],
    answer:
      "Shield is the DDoS layer: it detects and mitigates volumetric and protocol attacks, and Shield Advanced adds application-layer DDoS detection and automatic mitigation with WAF for protected resources. WAF inspects HTTP requests and applies rules, rate limits, bot controls, and managed rule groups. A credential-stuffing wave is an application-layer abuse pattern, not a volumetric flood, so WAF rate-based rules, bot controls, and account protection are the first controls. Shield may help if the wave is also a DDoS, but WAF is where the request content and login path are expressed. I would tune both with a false-positive budget and monitor legitimate login success.",
    followUps: [
      "How does a rate-based rule differ from a Shield mitigation?",
      "What does Shield Advanced automatic application-layer mitigation add?",
      "How do you avoid blocking shared NAT egress?",
    ],
    redFlags: [
      "Uses Shield alone for credential stuffing.",
      "Sets a global rate limit without considering NAT.",
      "Ignores false positives on the login path.",
    ],
    rubric: [
      "Places Shield at the network and DDoS layer.",
      "Places WAF at the request layer.",
      "Chooses WAF controls for credential stuffing.",
      "Includes false-positive measurement.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Classify the likely attack layers and the controls for each.",
      "Confirm which resources are protected and whether Shield Advanced is enabled.",
      "Set alarms on attack traffic, origin ingress, connection state, and legitimate error rate.",
      "Tune WAF and rate rules with a false-positive budget.",
      "Test mitigation with a controlled traffic exercise and record the time to absorb.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate attack traffic from a legitimate flash crowd.",
      "Confirm mitigation is enabled for the protected resource.",
      "Filter at the layer that matches the attack, not only at the origin.",
      "Watch for overflow at the mitigation layer and for L7 traffic that passes as valid.",
      "Communicate impact and protect legitimate users before chasing the attack source.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify origin ingress, connection state, and legitimate success rate.",
      "Review mitigation capacity and false positives.",
      "Update the runbook with the provider escalation path and the measured response time.",
      "Add the attack pattern to a game day and a detection rule.",
    ],
  },
];

const references = [
  {
    title: "How AWS Shield and Shield Advanced work",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/ddos-overview.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Shield Standard versus Advanced, and the L3, L4, and L7 attack classes.",
  },
  {
    title: "How AWS Shield mitigates events",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/ddos-event-mitigation.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Inline mitigation at the network border and edge locations, more than 100 Tbps aggregate capacity, and the application-layer path.",
  },
  {
    title: "Cloudflare DDoS Protection",
    url: "https://developers.cloudflare.com/ddos-protection/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Automatic L3-L7 DDoS detection and mitigation across plans, including managed rulesets.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "ddos-shield": {
      model: ddosShieldModel,
      presets,
      instructions:
        "Start Healthy. Apply Mitigation off and watch the origin collapse. Run the experiment, enable mitigation in the fix, then apply Scrubber overflow to see that mitigation capacity is finite.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Attack volumes, mitigation capacity, origin capacity, and the 2 Gbps legitimate load are teaching values. AWS documents more than 100 Tbps of aggregate mitigation capacity but does not publish a per-customer scrubbing figure; this lab uses a much smaller number so the overflow is visible. Real mitigation is behavioral, not a simple capacity subtraction.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-anycast", "traffic-waf-rate-limits", "traffic-alb-connection-limit", "traffic-global-accelerator"],
};
