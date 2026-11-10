import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASELINE_RPS = 3_000;

const params = [
  {
    id: "attackType",
    label: "Attack layer",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Attack",
    help: "0 is a volumetric L3/L4 flood absorbed by Shield. 1 is an L7 request flood that Shield does not inspect.",
    format: "count" as const,
  },
  {
    id: "attackRps",
    label: "Attack volume",
    min: 0,
    max: 100_000,
    step: 1_000,
    value: 0,
    unit: " req/s",
    group: "Attack",
    help: "Requests per second in the attack. Only the share that passes WAF reaches the origin on an L7 attack.",
    format: "rps" as const,
  },
  {
    id: "wafBlock",
    label: "WAF block rate",
    min: 0,
    max: 99,
    step: 1,
    value: 90,
    unit: "%",
    group: "WAF",
    help: "Share of L7 attack requests matched and blocked. A 99 percent block rate still passes 1 percent of a large flood.",
    format: "percent" as const,
  },
  {
    id: "originCapacity",
    label: "Origin capacity",
    min: 1_000,
    max: 50_000,
    step: 1_000,
    value: 10_000,
    unit: " req/s",
    group: "Origin",
    help: "Illustrative request capacity of the origin fleet, including application and database work per request.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  l7: boolean;
  attackRps: number;
  blockRate: number;
  originCapacity: number;
  passed: number;
  originLoad: number;
  blockedRate: number;
  utilization: number;
  errorRate: number;
  originHealth: Health;
  wafHealth: Health;
}

function compute(p: Params): Computed {
  const l7 = num(p, "attackType", 0) >= 0.5;
  const attackRps = Math.max(0, num(p, "attackRps", 0));
  const blockRate = clamp(num(p, "wafBlock", 90), 0, 99);
  const originCapacity = Math.max(1, num(p, "originCapacity", 10_000));
  const passed = l7 ? attackRps * (1 - blockRate / 100) : 0;
  const originLoad = BASELINE_RPS + passed;
  const blockedRate = l7 ? (attackRps > 0 ? blockRate : 0) : attackRps > 0 ? 100 : 0;
  const utilization = (originLoad / originCapacity) * 100;
  const errorRate = originLoad > originCapacity ? ((originLoad - originCapacity) / originLoad) * 100 : 0;
  const originHealth: Health = errorRate >= 5 || utilization >= 95 ? "crit" : utilization >= 80 ? "warn" : "ok";
  return {
    l7,
    attackRps,
    blockRate,
    originCapacity,
    passed,
    originLoad,
    blockedRate,
    utilization,
    errorRate,
    originHealth,
    wafHealth: l7 && attackRps > 0 && blockRate === 0 ? "crit" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["origin-utilization", values.utilization, 0],
    ["error-rate", values.errorRate, 0],
    ["blocked-rate", values.blockedRate, 0],
    ["origin-rps", values.originLoad, 10],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.4) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const attackLive = values.attackRps > 0;
  return {
    t: 0,
    nodes: [
      {
        id: "attacker",
        label: "attack traffic",
        kind: "external",
        health: attackLive ? "warn" : "ok",
        sublabel: `${formatCount(values.attackRps)} req/s · ${values.l7 ? "L7" : "L3/L4"}`,
        detail: values.l7
          ? "The flood uses valid-looking HTTP requests. Shield does not inspect this layer; WAF rules and rate-based rules do."
          : "The flood is volumetric. Shield absorbs L3/L4 traffic before it reaches the application listener.",
        meta: { view: "flow" },
      },
      {
        id: "shield",
        label: "AWS Shield",
        kind: "mesh",
        health: "ok",
        sublabel: values.l7 ? "L3/L4 only" : `absorbing ${formatCount(values.attackRps)}`,
        detail:
          "Shield protects the network and transport layers. It is not an application request firewall, so an L7 flood passes through it.",
        meta: { view: "flow" },
      },
      {
        id: "waf",
        label: "AWS WAF",
        kind: "mesh",
        health: values.wafHealth,
        sublabel: `${values.l7 ? formatPercent(values.blockRate) + "%" : "n/a"} blocked`,
        detail: values.l7
          ? `WAF matched and blocked ${formatPercent(values.blockRate)}% of the L7 attack. ${formatCount(
              values.passed,
            )} attack requests/s still pass.`
          : "WAF inspects HTTP requests. A volumetric flood is handled before this layer, so the block rate is not the relevant control.",
        meta: { view: "flow", blocked: Math.round(values.blockedRate) },
      },
      {
        id: "alb",
        label: "application load balancer",
        kind: "lb",
        health: values.originHealth,
        sublabel: `${formatCount(values.originLoad)} req/s to origin`,
        detail:
          "The load balancer forwards what WAF allows. A rate-based rule here or at the edge can drop excess requests before they consume origin capacity.",
        meta: { view: "flow" },
      },
      {
        id: "origin",
        label: "origin fleet",
        kind: "service",
        health: values.originHealth,
        utilization: clamp(values.utilization / 100),
        sublabel: `${Math.round(values.utilization)}% · ${formatPercent(values.errorRate)}% errors`,
        detail:
          values.errorRate > 0
            ? "The origin is above its modeled capacity. WAF is working as configured; the remaining request volume is still more than the origin can serve."
            : "The origin is within capacity. Protection at the edge does not remove the need to size the origin for the traffic that passes.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("attacker-shield", "attacker", "shield", 1, attackLive ? "warn" : "ok"),
      edge("shield-waf", "shield", "waf", values.l7 ? 1 : clamp(values.attackRps / 100_000), "ok"),
      edge("waf-alb", "waf", "alb", clamp(values.originLoad / Math.max(values.originCapacity, values.originLoad)), values.originHealth),
      edge("alb-origin", "alb", "origin", clamp(values.utilization / 100), values.originHealth),
    ],
    metrics: [
      metric("origin-utilization", "Origin utilization", values.utilization, "%", 80, 95, "percent"),
      metric("error-rate", "Origin error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("blocked-rate", "Attack blocked", values.blockedRate, "%", undefined, undefined, "percent"),
      metric("origin-rps", "Origin requests", values.originLoad, " req/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.attackRps)} attack req/s; ${formatPercent(
      values.blockedRate,
    )}% blocked; origin ${Math.round(values.utilization)}% utilized; ${formatPercent(
      values.errorRate,
    )}% errors.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "origin-utilization",
    metricId: "origin-utilization",
    warn: 80,
    crit: 95,
    title: "The origin is saturated by traffic that passed the edge",
    cause:
      "The origin receives more requests than it can serve. WAF may be blocking most of the attack, but the absolute volume that passes is still above capacity. Shield does not inspect L7 requests.",
    fix:
      "Add rate-based rules and tighter L7 matching, enable caching or a waiting room, and scale the origin for the residual traffic. Treat WAF and Shield as filters, not as capacity.",
    checkFirst: [
      "Compare attack volume with the WAF block rate to get the residual request rate.",
      "Check origin utilization and error rate, not only the blocked percentage.",
      "Check whether a rate-based rule exists for the attacked path.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The origin is returning errors under attack",
    cause:
      "The residual request volume exceeds origin capacity, so requests queue, time out, or fail. The error rate is a capacity symptom, even when the WAF block rate looks healthy.",
    fix:
      "Reduce the request rate before it reaches the origin, add capacity, and verify that retries are not multiplying the load. A WAF block rate is not a capacity plan.",
    checkFirst: [
      "Check origin latency and queue depth before changing WAF rules.",
      "Confirm whether the errors are local to the attacked path or spread across all routes.",
      "Check for retry amplification from clients and load balancers.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const wafShieldModel: SimModel = {
  id: "cloud-networking-waf-shield",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    const jitter = rng.between(-20, 20);
    next.metrics = next.metrics.map((item) =>
      item.id === "origin-rps" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.errorRate >= 5 && frame.flags.saturatedLogged !== 1) {
      pushEvent(next, {
        id: "origin-saturated",
        severity: "crit",
        title: "Origin saturated despite WAF blocking",
        detail: `${formatPercent(values.blockedRate)}% of the attack is blocked, but ${formatCount(
          values.passed,
        )} attack requests/s still pass. Origin load is ${formatCount(values.originLoad)} req/s against ${formatCount(
          values.originCapacity,
        )} capacity.`,
        nodeId: "origin",
        metricId: "error-rate",
      });
    }
    next.flags.saturatedLogged = values.errorRate >= 5 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (!values.l7 && values.attackRps > 0) {
      items.push(
        `A ${formatCount(values.attackRps)} req/s L3/L4 flood is mitigated before the application. Shield's scope is the network and transport layer; WAF is not the control for this attack.`,
      );
    } else if (values.l7) {
      items.push(
        `${formatPercent(values.blockRate)}% of a ${formatCount(
          values.attackRps,
        )} req/s L7 flood is blocked, leaving ${formatCount(values.passed)} attack requests/s. Add the ${formatCount(
          BASELINE_RPS,
        )} req/s baseline to get ${formatCount(values.originLoad)} req/s at the origin.`,
      );
    } else {
      items.push("No attack is active. The origin carries the baseline request rate and the edge is idle.");
    }
    items.push(
      values.errorRate > 0
        ? `The origin is at ${Math.round(values.utilization)}% of capacity and ${formatPercent(
            values.errorRate,
          )}% of requests fail. The WAF block rate is a filter metric, not a capacity metric.`
        : `The origin is at ${Math.round(values.utilization)}% of capacity. The residual traffic fits within the modeled fleet.`,
    );
    items.push(
      "Shield protects L3/L4; WAF inspects L7; rate-based rules cap request volume; origin capacity serves what remains. Each layer answers a different question.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No attack. The origin carries the 3,000 req/s baseline at 30% utilization.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 40,000 req/s L7 flood is 90% blocked, leaving 7,000 req/s against 8,000 capacity.",
    tone: "warn",
    params: defaults({ attackType: 1, attackRps: 40_000, wafBlock: 90, originCapacity: 8_000 }),
  },
  {
    id: "failure",
    label: "L7 saturation",
    description: "A 60,000 req/s L7 flood is 95% blocked, but 3,000 residual requests plus the baseline overwhelm a 4,000 req/s origin.",
    tone: "crit",
    params: defaults({ attackType: 1, attackRps: 60_000, wafBlock: 95, originCapacity: 4_000 }),
  },
  {
    id: "volumetric",
    label: "Volumetric flood",
    description: "A 100,000 req/s L3/L4 flood is absorbed by Shield; the application origin stays at baseline.",
    tone: "warn",
    params: defaults({ attackType: 0, attackRps: 100_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The attack stops and the origin returns to baseline utilization.",
    tone: "ok",
    params: defaults({ attackRps: 0, originCapacity: 8_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-residual-flood",
  title: "Predict the residual request rate",
  simId: "edge-defense",
  question:
    "A 100,000 req/s L7 flood hits a site with a 3,000 req/s baseline. WAF blocks 99 percent. Origin capacity is 4,000 req/s. What happens?",
  prediction: {
    options: [
      { id: "safe", label: "The origin is safe because 99 percent of the attack is blocked." },
      { id: "saturated", label: "The origin is still saturated: 1,000 attack requests plus 3,000 baseline equal capacity." },
      { id: "shield", label: "Shield absorbs the rest before it reaches the origin." },
      { id: "waf-scale", label: "WAF automatically scales the origin to match demand." },
    ],
    correctOptionId: "saturated",
    explanation:
      "The block rate is relative to a huge number. One percent of 100,000 is 1,000 requests/s, and the baseline still uses 3,000. The origin receives 4,000 req/s, exactly its modeled capacity, so utilization reaches the critical line and any burst causes errors. A higher block rate or a rate-based rule is needed, not a different name for the same residual volume.",
  },
  setup: defaults({ attackType: 1, attackRps: 100_000, wafBlock: 99, originCapacity: 4_000 }),
  runFor: 15,
  observe: [
    "The WAF reports a 99 percent block rate.",
    "The origin still reaches 100 percent utilization.",
    "The blocked percentage and the residual request rate tell different stories.",
    "Shield is healthy but does not reduce the L7 request count.",
  ],
  explain:
    "Edge protection reduces the volume that reaches the origin; it does not make the origin infinitely scalable. The residual is attack volume times the pass rate, plus legitimate traffic. At 100,000 req/s and a 99 percent block rate, the residual is 1,000 attack requests/s, which is enough to fill a 4,000 req/s origin alongside the baseline. The missing controls are rate limiting and origin capacity.",
  fix: defaults({ attackType: 1, attackRps: 100_000, wafBlock: 99, originCapacity: 12_000 }),
  debrief:
    "A high block percentage is not a capacity guarantee. Compute the residual, compare it with capacity, and add rate-based rules for the attacked path. Shield and WAF are filters; the origin still has to serve what passes.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Shield is a managed distributed denial of service (DDoS) protection service. Shield Standard is automatic for AWS customers and protects network and transport layers, typically described as Layer 3 and Layer 4. AWS WAF is a web application firewall that inspects HTTP and HTTPS requests at Layer 7. It matches rules against headers, paths, query strings, IP sets, and rate thresholds.",
  },
  {
    type: "p",
    text: "The two services answer different questions. Shield asks whether the traffic is a volumetric network attack. WAF asks whether an HTTP request matches a pattern or exceeds a rate. Neither one replaces origin capacity, caching, or a rate limit that matches the application's real work.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is attacker, Shield, WAF, load balancer, origin. Shield sees the packet volume before the application listener. WAF evaluates the request after the connection is accepted. The origin serves whatever the edge allows. A volumetric flood can be absorbed before WAF; an L7 flood passes Shield and is filtered by WAF rules.",
  },
  {
    type: "table",
    headers: ["Layer", "Control", "What it sees", "What it cannot do"],
    rows: [
      ["L3/L4", "Shield", "Packet volume, protocol behavior, network flood", "Inspect an HTTP path or distinguish a valid request from a malicious one."],
      ["L7", "WAF rules", "HTTP request fields and rate patterns", "Absorb a volumetric flood or add origin capacity."],
      ["L7 volume", "Rate-based rule", "Requests per source or path over a window", "Serve the residual traffic or replace a capacity plan."],
      ["Origin", "Capacity and caching", "Application work per request", "Filter a flood before it consumes worker slots."],
    ],
  },
  {
    type: "p",
    text: "The table is the lesson in one view. Each control has a scope, and a gap appears when an attack crosses from one scope into another. A 99 percent block rate on a 100,000 req/s flood still leaves 1,000 requests per second. If the origin serves 4,000, the residual plus the baseline can fill it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Attack layer: L3/L4 volumetric or L7 request flood.",
      "WAF block rate and the residual request rate that reaches the origin.",
      "Origin utilization and error rate, which can cross critical while the block rate looks healthy.",
      "Five nodes: attacker, Shield, WAF, load balancer, and origin.",
      "A prediction experiment that asks whether a 99 percent block rate protects a small origin.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply L7 saturation and read the WAF block rate next to the origin utilization. The block rate is high and the origin still fails. Compare that with Volumetric flood, where Shield handles the attack and the origin stays at baseline. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The request rates, block percentages, and origin capacity are illustrative. The layer scopes, the residual-rate arithmetic, and the division of responsibility between Shield, WAF, rate limiting, and capacity are the parts to carry into production.",
  },
  { type: "sim", simId: "edge-defense" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The WAF blocked 95 percent of a 60,000 req/s L7 flood, which sounds like success. The remaining 3,000 attack requests per second joined the 3,000 req/s baseline and pushed a 4,000 req/s origin to 150 percent utilization. The origin failed while the WAF metric stayed green.",
  },
  {
    type: "p",
    text: "The volumetric preset told a different story. Shield absorbed the L3/L4 flood before the application, so the origin never saw the attack volume. The same attack number produced no origin pressure because the layer and the control matched.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "WAF metrics: allowed, blocked, and counted requests by rule and by terminating rule.",
      "Shield event details and DDoS response history for network-layer attacks.",
      "Load balancer request count, target response time, and 5xx rate.",
      "Origin CPU, worker saturation, queue depth, and database connection pressure.",
      "Rate-based rule matches: the source or path that crossed the threshold.",
      "Retry amplification: clients and load balancers retrying requests that the origin cannot serve.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute the residual request rate before trusting a block percentage. Compare it with origin capacity and the legitimate baseline. If the origin is saturated, the next control is rate limiting or capacity, not another WAF rule that blocks the same requests more thoroughly.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the attack layer from Shield events and request logs.",
      "For L7, compute attack volume times the pass rate and add the legitimate baseline.",
      "Add a rate-based rule for the attacked path or source with a threshold tied to origin capacity.",
      "Tighten WAF matching only where it reduces the residual without blocking legitimate traffic.",
      "Enable caching or a waiting room for the expensive path.",
      "Scale the origin for the residual that remains, and cap retries.",
      "Re-test at the expected attack volume; a higher block rate alone is not a capacity test.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A strict WAF rule lowers the residual but can block legitimate clients and create a support load.",
      "A rate-based rule protects the origin but must be tuned to normal bursts or it becomes the outage.",
      "Shield Advanced adds response support and cost protection, but it still does not inspect application requests.",
      "Scaling the origin absorbs the residual but raises cost for traffic that should have been filtered.",
      "Caching reduces origin work for repeated requests, but an attack on unique paths bypasses the cache.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "layer-scope",
    question: "What does Shield protect that WAF does not, and what does WAF protect that Shield does not?",
    difficulty: 2,
    hints: [
      "One works on packets, the other on HTTP requests.",
      "A high block rate is not a capacity plan.",
    ],
    answer:
      "Shield protects the network and transport layers against volumetric DDoS, such as packet floods and protocol attacks. It does not inspect HTTP paths or distinguish a valid application request from a malicious one. WAF inspects HTTP and HTTPS requests and can block by header, path, query string, IP set, or rate. It does not absorb a volumetric flood, and it does not add origin capacity. I use Shield for L3/L4, WAF and rate-based rules for L7, and capacity plus caching for what remains.",
    followUps: [
      "Which layer would a SYN flood target?",
      "What does a rate-based rule add to a WAF rule?",
      "Why can a 99 percent block rate still saturate the origin?",
    ],
    redFlags: [
      "Treats Shield and WAF as interchangeable.",
      "Believes WAF blocks all DDoS.",
      "Ignores origin capacity.",
    ],
    rubric: [
      "Separates L3/L4 from L7.",
      "Names the scope of each control.",
      "Adds rate limiting and capacity.",
      "Explains the residual.",
    ],
  },
  {
    id: "residual-rate",
    question:
      "An L7 flood of 100,000 req/s is 99 percent blocked. The origin serves 4,000 req/s and the baseline is 3,000. What do you do?",
    difficulty: 3,
    hints: [
      "Compute the residual, then add the baseline.",
      "The origin is at capacity before any burst.",
    ],
    answer:
      "One percent of 100,000 is 1,000 attack requests per second. Add the 3,000 baseline and the origin receives 4,000, exactly its capacity. Any burst creates errors. I would add a rate-based rule for the attacked path, tighten matching only if it reduces the residual without blocking legitimate clients, cache the expensive path, and scale the origin for the remaining traffic. I would also cap retries so failed requests do not multiply the load.",
    followUps: [
      "What threshold would you set on the rate-based rule?",
      "How would you measure whether the rule blocked legitimate traffic?",
      "Would you scale first or filter first?",
    ],
    redFlags: [
      "Says 99 percent is enough.",
      "Adds a WAF rule with no rate limit.",
      "Scales without checking retries or cacheability.",
    ],
    rubric: [
      "Computes the residual.",
      "Adds the baseline.",
      "Chooses rate limiting or capacity.",
      "Considers retries and legitimate traffic.",
    ],
  },
  {
    id: "attack-response",
    question: "Walk through the first ten minutes of an L7 attack on a public API.",
    difficulty: 3,
    hints: [
      "Identify the layer and the targeted path.",
      "Protect the origin before perfecting the rules.",
    ],
    answer:
      "I would confirm the attack layer from Shield events and request logs, then identify the targeted path and the residual rate reaching the origin. I would enable or tighten a rate-based rule for that path and a temporary block for the dominant bad pattern, while watching the legitimate request rate and error rate. I would check origin saturation and cap retries. If the origin is still saturated, I would scale or shed low-priority traffic. Throughout, I would keep a rollback for each rule and communicate the customer-visible impact.",
    followUps: [
      "Which metric tells you the rule is working?",
      "How do you avoid blocking legitimate clients?",
      "When would you involve Shield Response Team?",
    ],
    redFlags: [
      "Changes many rules at once without rollback.",
      "Ignores the legitimate traffic share.",
      "Waits for the origin to fail before acting.",
    ],
    rubric: [
      "Identifies layer and path.",
      "Uses rate limiting and targeted blocks.",
      "Protects origin capacity.",
      "Keeps rollback and customer impact visible.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Shield event notifications and WAF metrics are routed to the on-call rotation.",
      "Rate-based rules exist for expensive and unauthenticated paths.",
      "Origin capacity and cache behavior are documented per route.",
      "WAF rules have a staging or count mode before block mode.",
      "Retry policies have a cap and jitter.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the attack layer before changing a control.",
      "Compute the residual request rate from attack volume and block rate.",
      "Compare residual plus baseline with origin capacity.",
      "Add a targeted rate limit or block with a rollback path.",
      "Watch legitimate traffic and origin errors together.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Tune the rate threshold to normal peak behavior.",
      "Add a load test at the expected attack volume.",
      "Review cacheability and origin headroom for the attacked path.",
      "Record which layer failed and which control actually reduced the residual.",
    ],
  },
];

const references = [
  {
    title: "What is AWS WAF?",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/what-is-aws-waf.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "WAF scope, rule groups, and web access control lists.",
  },
  {
    title: "What is AWS Shield?",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/shield-chapter.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Shield Standard and Advanced protection for network and transport layers.",
  },
  {
    title: "Rate-based rule statements",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How WAF counts requests over a window and acts on the rate.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "edge-defense": {
      model: wafShieldModel,
      presets,
      instructions:
        "Start healthy, then compare an L7 flood with a volumetric flood. Read the block rate and the origin utilization together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Attack rates, block percentages, and origin capacity are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-ddos-shield", "cloud-networking-flow-logs", "cloud-networking-nat-scaling"],
};
