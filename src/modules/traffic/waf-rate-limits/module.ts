import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const LOGIN_CAPACITY = 4_000;
const ATTACK_IPS = 2_000;
const LEGIT_IPS = 8_000;
const NAT_SHARE = 0.35;
const NAT_IPS = 200;
const LOGIN_SHARE = 0.12;
const WINDOW_SECONDS = 300;
const BASE_LATENCY_MS = 80;

const params = [
  {
    id: "attackRps",
    label: "Attack request rate",
    min: 0,
    max: 40_000,
    step: 500,
    value: 0,
    unit: " rps",
    group: "Traffic",
    help: "Credential-stuffing requests per second aimed at the login endpoint. The model spreads them across a fixed number of source IPs.",
    format: "rps" as const,
  },
  {
    id: "legitRps",
    label: "Legitimate request rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " rps",
    group: "Traffic",
    help: "Normal traffic per second. Only a share of it goes to the login endpoint; the rest is browsing and API reads.",
    format: "rps" as const,
  },
  {
    id: "limitPerFiveMin",
    label: "Rate limit per IP",
    min: 50,
    max: 5_000,
    step: 50,
    value: 600,
    unit: " req/5m",
    group: "Rule",
    help: "Requests allowed from one aggregation key in a five-minute window. The model converts this to a per-second rate for comparison.",
    format: "count" as const,
  },
  {
    id: "scope",
    label: "Rule scope (0 all paths, 1 login only)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rule",
    help: "Login only counts the endpoint under attack. All paths also counts browsing traffic, which makes a shared IP hit the threshold sooner.",
    format: "count" as const,
  },
  {
    id: "action",
    label: "Rule action (0 count, 1 block)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rule",
    help: "Count records matches without stopping them. Block rejects the request at the edge. Use count mode to measure false positives before enforcing.",
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

interface Computed {
  attackRps: number;
  legitRps: number;
  limitPerFiveMin: number;
  limitRps: number;
  scope: number;
  action: number;
  attackPerIp: number;
  legitNatRate: number;
  legitOtherRate: number;
  attackBlockedShare: number;
  legitBlockedShare: number;
  attackPass: number;
  falsePositive: number;
  loginLoad: number;
  blockedRps: number;
  blockedRate: number;
  originUtil: number;
  p99: number;
}

function compute(p: Params): Computed {
  const attackRps = Math.max(0, num(p, "attackRps", 0));
  const legitRps = Math.max(1, num(p, "legitRps", 4_000));
  const limitPerFiveMin = Math.max(10, num(p, "limitPerFiveMin", 600));
  const limitRps = limitPerFiveMin / WINDOW_SECONDS;
  const scope = Math.round(clamp(num(p, "scope", 1), 0, 1));
  const action = Math.round(clamp(num(p, "action", 1), 0, 1));
  const legitInScope = scope === 1 ? legitRps * LOGIN_SHARE : legitRps;
  const attackPerIp = attackRps / ATTACK_IPS;
  const legitNatRate = (legitInScope * NAT_SHARE) / NAT_IPS;
  const legitOtherRate = (legitInScope * (1 - NAT_SHARE)) / (LEGIT_IPS - NAT_IPS);
  const attackBlockedShare = action === 1 && attackPerIp > limitRps ? 1 : 0;
  const natBlocked = action === 1 && legitNatRate > limitRps;
  const otherBlocked = action === 1 && legitOtherRate > limitRps;
  const blockedInScopeShare = (natBlocked ? NAT_SHARE : 0) + (otherBlocked ? 1 - NAT_SHARE : 0);
  const scopeShare = scope === 1 ? LOGIN_SHARE : 1;
  const legitBlockedShare = blockedInScopeShare * scopeShare;
  const attackPass = attackRps > 0 ? (1 - attackBlockedShare) * 100 : 0;
  const falsePositive = legitBlockedShare * 100;
  const loginLoad =
    legitRps * LOGIN_SHARE * (1 - blockedInScopeShare) + attackRps * (1 - attackBlockedShare);
  const blockedRps = legitRps * legitBlockedShare + attackRps * attackBlockedShare;
  const blockedRate = (blockedRps / Math.max(1, legitRps + attackRps)) * 100;
  const originUtil = (loginLoad / LOGIN_CAPACITY) * 100;
  const ratio = loginLoad / LOGIN_CAPACITY;
  const queueing = ratio > 0.85 ? Math.min(2_000, ((ratio - 0.85) / 0.15) * 120) : 0;
  const p99 = BASE_LATENCY_MS + queueing;
  return {
    attackRps,
    legitRps,
    limitPerFiveMin,
    limitRps,
    scope,
    action,
    attackPerIp,
    legitNatRate,
    legitOtherRate,
    attackBlockedShare,
    legitBlockedShare,
    attackPass,
    falsePositive,
    loginLoad,
    blockedRps,
    blockedRate,
    originUtil,
    p99,
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

function buildFrame(d: Computed, seed: number): SimFrame {
  const edgeHealth =
    d.falsePositive >= 5 || d.attackPass >= 15
      ? "crit"
      : d.falsePositive >= 1 || d.attackPass >= 5
        ? "warn"
        : "ok";
  const originHealth = healthFor(d.originUtil, 70, 90);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: d.legitRps + d.attackRps,
        sublabel: `${formatCount(d.legitRps)} legit · ${formatCount(d.attackRps)} attack rps`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge WAF",
        kind: "lb",
        health: edgeHealth,
        utilization: clamp((d.legitRps + d.attackRps) / 60_000),
        throughput: d.legitRps + d.attackRps - d.blockedRps,
        sublabel: `${d.action === 1 ? "Block" : "Count"} · ${formatCount(d.limitPerFiveMin)}/5m per IP`,
        detail: `${d.scope === 1 ? "Login path only" : "All paths"}. The rule aggregates by source IP over a five-minute window. Attack traffic is spread across ${formatCount(ATTACK_IPS)} addresses.`,
        meta: { view: "flow", scope: d.scope, action: d.action },
      },
      {
        id: "origin",
        label: "Login service",
        kind: "service",
        health: originHealth,
        utilization: clamp(d.originUtil / 100),
        throughput: d.loginLoad,
        capacity: LOGIN_CAPACITY,
        sublabel: `${formatCount(d.loginLoad)} rps admitted`,
        detail: `Illustrative login capacity is ${formatCount(LOGIN_CAPACITY)} rps. About ${LOGIN_SHARE * 100}% of legitimate traffic goes to login; all attack traffic does.`,
        meta: { view: "flow" },
      },
      {
        id: "blocked",
        label: "Blocked at edge",
        kind: "external",
        health: "ok",
        throughput: d.blockedRps,
        sublabel: `${formatCount(d.blockedRps)} rps rejected`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", (d.legitRps + d.attackRps) / 50_000, edgeHealth),
      edge("edge-origin", "edge", "origin", d.loginLoad / 50_000, originHealth),
      edge("edge-blocked", "edge", "blocked", d.blockedRps / 50_000, "ok"),
    ],
    metrics: [
      metric("false-positive", "Legitimate requests blocked", d.falsePositive, "%", 1, 5, "percent"),
      metric("attack-pass", "Attack requests passing", d.attackPass, "%", 5, 15, "percent"),
      metric("login-load", "Login service load", d.loginLoad, " rps", 3_000, 4_000, "rps"),
      metric("p99", "Login p99", d.p99, " ms", 300, 800, "ms"),
      metric("blocked-rate", "Total requests blocked", d.blockedRate, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      scope: d.scope,
      action: d.action,
      falsePositive: d.falsePositive,
      attackPass: d.attackPass,
    },
    summary: `${formatCount(d.attackRps)} attack rps and ${formatCount(d.legitRps)} legit rps; ${d.attackPass.toFixed(0)}% of attack passes; ${d.falsePositive.toFixed(1)}% of legitimate traffic is blocked; login load ${formatCount(d.loginLoad)} rps.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.04 * Math.sin((index + (seed % 5)) / 2.3)) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "false-positive",
    metricId: "false-positive",
    warn: 1,
    crit: 5,
    title: "Legitimate users are being blocked",
    cause:
      "The rate rule aggregates by source IP. Many users behind a shared NAT or corporate proxy look like one high-rate client, so the limit blocks the group. A broad rule scope makes it worse by counting browsing traffic as well as login attempts.",
    fix:
      "Scope the rate rule to the login path, raise the threshold above the shared-IP aggregate, and aggregate by an authenticated key such as an API key or account where possible. Run in count mode first and measure the false-positive rate before blocking.",
    checkFirst: [
      "List the top source IPs and their request rates; a small number of very high IPs may be NAT gateways.",
      "Compare the rule scope with the endpoint under attack.",
      "Check count-mode data for legitimate requests that would have matched.",
    ],
  },
  {
    id: "attack-pass",
    metricId: "attack-pass",
    warn: 5,
    crit: 15,
    title: "Attack traffic is passing the edge rule",
    cause:
      "A distributed attack spreads requests across many addresses, so each source stays under a per-IP threshold. The rule may also be in count mode or scoped to a path the attack does not use.",
    fix:
      "Aggregate on a key the attack cannot rotate cheaply, such as the account or session being targeted, and add bot or managed-rule signals for credential stuffing. Lower the per-IP limit only after checking the NAT false-positive risk; test in count mode.",
    checkFirst: [
      "Check the distribution of attack requests per IP, not just the total.",
      "Confirm the rule action and scope.",
      "Compare login failure rate and account lockouts with the attack volume.",
    ],
  },
  {
    id: "login-load",
    metricId: "login-load",
    warn: 3_000,
    crit: 4_000,
    title: "Login service load crossed its capacity",
    cause:
      "Attack traffic is reaching the login service, or legitimate peak traffic is above the capacity the service was sized for. Edge blocking should remove attack load before it reaches compute.",
    fix:
      "Block the attack at the edge, add a queue or concurrency limit at the login service, and scale capacity only after the edge rule is effective. A WAF that counts instead of blocks protects nothing.",
    checkFirst: [
      "Split login load into legitimate and attack traffic.",
      "Check whether the edge rule is blocking or counting.",
      "Check login 5xx, latency, and queue depth together.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Login latency crossed the objective",
    cause:
      "The login service is queueing under attack or legitimate peak load. Blocking at the edge reduces the queue; adding capacity without blocking only moves the saturation point.",
    fix:
      "Enforce the edge rule, bound login concurrency, and return a clear 429 with a retry hint to blocked clients. Keep retries out of the same bucket as new attempts.",
    checkFirst: [
      "Compare login p99 with admitted request rate.",
      "Check whether blocked requests are retried immediately.",
      "Check database and password-hashing latency, which can dominate login time.",
    ],
  },
];

export const wafRateLimitsModel: SimModel = {
  id: "traffic-waf-rate-limits",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const noise = rng.between(-0.01, 0.01);
    const p99 = Math.max(0, d.p99 * (1 + noise));
    const next = buildFrame(d, seed);
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
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: p99 } : item,
    );
    const previousScope = Number(frame.flags.scope ?? d.scope);
    const previousAction = Number(frame.flags.action ?? d.action);
    if (d.scope !== previousScope || d.action !== previousAction) {
      pushEvent(next, {
        id: "rule-change",
        at: frame.t,
        severity: "info",
        title: `WAF rule changed: ${d.scope === 1 ? "login only" : "all paths"}, ${d.action === 1 ? "block" : "count"}`,
        detail: `The rule allows ${formatCount(d.limitPerFiveMin)} requests per IP per five minutes. At this setting, ${d.falsePositive.toFixed(1)}% of legitimate traffic and ${d.attackPass.toFixed(0)}% of attack traffic would be affected.`,
        nodeId: "edge",
        metricId: "false-positive",
      });
    }
    if (d.falsePositive >= 5 && frame.flags.falsePositiveSpike !== 1) {
      pushEvent(next, {
        id: "false-positive-spike",
        at: frame.t,
        severity: "crit",
        title: "Shared IPs are hitting the rate limit",
        detail: `${d.falsePositive.toFixed(1)}% of legitimate traffic is blocked. A NAT or proxy IP carries about ${formatCount(d.legitNatRate * 300)} requests per five minutes against a ${formatCount(d.limitPerFiveMin)} limit.`,
        nodeId: "edge",
        metricId: "false-positive",
      });
      next.flags.falsePositiveSpike = 1;
    }
    if (d.falsePositive < 5) next.flags.falsePositiveSpike = 0;
    if (d.attackPass >= 15 && d.attackRps > 0 && frame.flags.attackPassing !== 1) {
      pushEvent(next, {
        id: "attack-passing",
        at: frame.t,
        severity: "crit",
        title: "Distributed attack is passing the per-IP rule",
        detail: `Each attack IP sends about ${d.attackPerIp.toFixed(1)} rps, below the ${d.limitRps.toFixed(1)} rps equivalent of the configured limit. The edge is not blocking the attack.`,
        nodeId: "edge",
        metricId: "attack-pass",
      });
      next.flags.attackPassing = 1;
    }
    if (d.attackPass < 15 || d.attackRps <= 0) next.flags.attackPassing = 0;
    if (d.originUtil >= 90 && frame.flags.loginOverload !== 1) {
      pushEvent(next, {
        id: "login-overload",
        at: frame.t,
        severity: "crit",
        title: "Login service reached its illustrative capacity",
        detail: `${formatCount(d.loginLoad)} rps is reaching a service sized for ${formatCount(LOGIN_CAPACITY)} rps.`,
        nodeId: "origin",
        metricId: "login-load",
      });
      next.flags.loginOverload = 1;
    }
    if (d.originUtil < 90) next.flags.loginOverload = 0;
    next.flags.scope = d.scope;
    next.flags.action = d.action;
    next.flags.falsePositive = d.falsePositive;
    next.flags.attackPass = d.attackPass;
    next.summary = `${formatCount(d.attackRps)} attack rps and ${formatCount(d.legitRps)} legit rps; ${d.attackPass.toFixed(0)}% of attack passes; ${d.falsePositive.toFixed(1)}% of legitimate traffic is blocked; login load ${formatCount(d.loginLoad)} rps.`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `The rule allows ${formatCount(d.limitPerFiveMin)} requests per IP per five minutes, or about ${d.limitRps.toFixed(1)} rps. Attack traffic averages ${d.attackPerIp.toFixed(1)} rps per source.`,
    );
    items.push(
      `Legitimate traffic behind a shared NAT averages ${d.legitNatRate.toFixed(2)} rps per IP in the rule's scope. That is the group a per-IP limit can punish.`,
    );
    if (d.scope === 0) {
      items.push(
        "The rule counts all paths. Browsing and static requests inflate a shared IP's count, so the limit fires before the login endpoint is actually abusive.",
      );
    } else {
      items.push(
        "The rule counts only the login path. That reduces collateral load, but it also means the attack must target that path to be counted.",
      );
    }
    if (d.action === 0) {
      items.push(
        "Count mode observes matches without blocking. It is the right way to measure false positives, but it does not protect the login service.",
      );
    }
    if (d.attackPass > 0) {
      items.push(
        `${d.attackPass.toFixed(0)}% of attack traffic passes. A per-IP ceiling only sees rate; a distributed attack can stay below it.`,
      );
    }
    if (d.falsePositive > 0) {
      items.push(
        `${d.falsePositive.toFixed(1)}% of legitimate traffic is blocked. That is the cost of choosing the wrong aggregation key or scope.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Protected", tone: "ok" },
    { label: "False positives", tone: "warn" },
    { label: "Attack passing", tone: "crit" },
    { label: "Blocked", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No attack, login-scoped rule, and a limit well above the shared NAT rate.",
    tone: "ok",
    params: defaults({ attackRps: 0, legitRps: 4_000, limitPerFiveMin: 600, scope: 1, action: 1 }),
  },
  {
    id: "peak",
    label: "Shared NAT",
    description: "A login-scoped rule blocks the attack but also catches legitimate users behind a busy NAT.",
    tone: "warn",
    params: defaults({ attackRps: 12_000, legitRps: 8_000, limitPerFiveMin: 300, scope: 1, action: 1 }),
  },
  {
    id: "failure",
    label: "All-path overblock",
    description: "An all-path rule at a low threshold blocks a third of legitimate traffic while the attack is stopped.",
    tone: "crit",
    params: defaults({ attackRps: 20_000, legitRps: 8_000, limitPerFiveMin: 300, scope: 0, action: 1 }),
  },
  {
    id: "recovery",
    label: "Tuned login rule",
    description: "Login-scoped rule with a threshold above the NAT aggregate; the attack is blocked and legitimate traffic passes.",
    tone: "ok",
    params: defaults({ attackRps: 20_000, legitRps: 4_000, limitPerFiveMin: 600, scope: 1, action: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-distributed-attack",
  title: "Predict what a per-IP limit does to a distributed attack",
  simId: "waf-rate-limits",
  question:
    "A credential-stuffing wave sends 20,000 rps across 2,000 source IPs, so each IP sends 10 rps. The login service is sized for 4,000 rps. You set a per-IP limit of 3,000 requests per five minutes and block. What happens?",
  prediction: {
    options: [
      { id: "passes", label: "The attack passes: 10 rps per IP is at the threshold, and the login service saturates." },
      { id: "blocked", label: "The attack is blocked because 10 rps is above the limit." },
      { id: "nat", label: "Legitimate NAT users are blocked; the attack passes." },
      { id: "capacity", label: "Nothing happens until the login service adds capacity." },
    ],
    correctOptionId: "passes",
    explanation:
      "A limit of 3,000 requests per five minutes is 10 rps. The attack averages 10 rps per IP, so it sits at the threshold rather than above it, and the rule does not block it. The login service then receives the full 20,000 attack rps on top of legitimate login traffic. This is the blind spot of a per-IP rate ceiling: a distributed attacker can shape the rate to stay under it. The fix is to aggregate on an identity the attacker cannot rotate as cheaply, add behavioral or bot signals, or lower the limit while measuring the shared-NAT false positives in count mode.",
  },
  setup: defaults({
    attackRps: 20_000,
    legitRps: 4_000,
    limitPerFiveMin: 3_000,
    scope: 1,
    action: 1,
  }),
  runFor: 20,
  observe: [
    "Attack pass-through is 100%; every attack IP sends about 10 rps against a 10 rps threshold.",
    "Login load is about 20,480 rps against an illustrative capacity of 4,000 rps.",
    "Login p99 reaches about 2.1 s and the origin crosses critical.",
    "False positives stay at zero: the rule is not firing, so it is not protecting anything.",
  ],
  explain:
    "A rate-based rule counts requests over a window and compares the count with a threshold. It is a ceiling, not a classifier. When the attacker controls the distribution, the per-IP rate can be shaped to sit below the ceiling while the total remains high. Scoping the rule to login helps with collateral damage but does not change the arithmetic. The useful complements are aggregation on the targeted account or session, managed rules for known attack patterns, bot signals, and a login service that can shed or queue excess requests.",
  fix: defaults({
    attackRps: 20_000,
    legitRps: 4_000,
    limitPerFiveMin: 600,
    scope: 1,
    action: 1,
  }),
  debrief:
    "With a 600-per-five-minute limit (2 rps), the same attack is blocked and legitimate NAT traffic stays below the threshold in this model. That is a tuning win, not a general solution: an attacker who sends 1.5 rps per IP would pass again. The durable design combines a per-IP ceiling with an identity-based limit and a behavioral signal, and it keeps the rule in count mode long enough to measure the collateral before enforcing.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A web application firewall (WAF) inspects HTTP requests at the edge and applies rules before the request reaches the origin. A rule can match on path, method, headers, cookies, IP address, or request body, and it can allow, block, challenge, or count the request. A rate-based rule adds a counter: it aggregates requests by a key over a time window and matches when the count crosses a threshold. AWS WAF rate-based rules use a sliding window and can aggregate on IP or another request attribute; Cloudflare rate limiting rules evaluate request characteristics over a configured period. Both let you choose the action and the scope.",
  },
  {
    type: "p",
    text: "The hard part is not writing the rule; it is choosing the aggregation key and the threshold. A per-IP limit sees a source address, not a person. Many users behind a corporate NAT, a mobile carrier, or a VPN share one address, so a limit that stops an abusive client can also stop a whole building. A distributed credential-stuffing attack does the opposite: it spreads requests across thousands of addresses, so each source stays under the per-IP threshold while the total against the login service is enormous.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge WAF, origin. Edge enforcement is valuable because the blocked request never consumes login CPU, database connections, or password-hashing capacity. The edge sees the source IP, the request rate, the path, and the headers; it may not know which account is being targeted until the request reaches the application. That is why the aggregation key matters. A rule scoped to the login path reduces collateral damage from browsing traffic, but it also narrows what the rule can see. A rule scoped to all paths catches more, including legitimate users who happen to be busy.",
  },
  {
    type: "compare",
    leftTitle: "Per-IP rate rule",
    rightTitle: "Identity or behavioral rule",
    rows: [
      { label: "What it counts", left: "Requests from one source address", right: "Requests per account, session, API key, or attack signature" },
      { label: "Stops", left: "A single high-rate client or a small botnet", right: "Distributed low-and-slow attempts against one identity" },
      { label: "Blind spot", left: "Attackers who rotate IPs or stay under the threshold", right: "Requires an identity or signal that is available before login" },
      { label: "Collateral", left: "Shared NAT, proxies, and carrier-grade NAT", right: "Shared accounts or false behavioral matches" },
    ],
  },
  {
    type: "p",
    text: "The rule action is a separate decision from the match. Count mode records matches without stopping them; it is how you measure the false-positive rate before enforcing. Block mode rejects at the edge. Challenge mode asks for proof of browser or client behavior and is often a better fit for suspicious but not clearly malicious traffic. A rule that blocks aggressively without a count-mode baseline is a guess about both the attack and the customer base.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Attack pass-through and legitimate false positives, which have to be read together; either one alone can make a rule look good or bad.",
      "Login service load and p99, the reason edge enforcement exists.",
      "Blocked request rate, which shows how much traffic the rule is actually removing.",
      "The shared-NAT rate and the attack rate per IP, so the threshold can be compared with both populations.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Shared NAT to see a login-scoped rule block the attack and still catch legitimate users behind one address. Apply All-path overblock to see the collateral damage grow. Run the experiment to see a distributed attack pass a per-IP threshold. Compare the count and block actions before choosing a production setting.",
  },
  {
    type: "table",
    headers: ["Rule type", "Catches", "Blind spot", "False-positive risk"],
    rows: [
      ["Per-IP rate limit", "High-rate single sources, simple floods", "Distributed low-and-slow attacks, IP rotation", "High for NAT, proxies, and mobile carriers"],
      ["Per-account or per-session limit", "Credential stuffing against one identity", "Attackers who spread across many accounts", "Shared accounts and family plans"],
      ["Managed rule group", "Known signatures and attack patterns", "Novel or custom application abuse", "Depends on rule paranoia and app behavior"],
      ["Bot or behavioral signal", "Automation and unusual request patterns", "Sophisticated clients that mimic browsers", "False positives on accessibility tools and API clients"],
      ["Global or per-key quota", "One tenant or key consuming shared capacity", "Abuse spread across many keys", "Legitimate tenants with bursty workloads"],
    ],
  },
  {
    type: "p",
    text: "The first question is what the attacker can rotate cheaply. If it is the IP, a per-IP rule is a weak ceiling. If it is the account, a per-account rule is weak. The second question is who shares the key: a per-IP rule shares a key across everyone behind a NAT, and a per-key rule shares a key across every user of that key. The threshold has to be above the legitimate aggregate and below the abusive one, which is sometimes impossible with one rule. That is when you combine rules rather than tuning one.",
  },
  { type: "sim", simId: "waf-rate-limits" },
  { type: "experiment", experimentId: "predict-distributed-attack" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset scoped a low per-IP limit to all paths. The rule stopped the attack, but it also blocked about a third of legitimate traffic because a shared NAT address carried many users. The peak preset scoped the same rule to login: the attack was still blocked, and the collateral fell but did not disappear because the NAT aggregate was close to the threshold. The experiment moved to a distributed attack: 20,000 rps across 2,000 IPs put each source at the threshold, so the rule did not fire, and the login service saw the full attack.",
  },
  {
    type: "p",
    text: "The common thread is that a rate rule is only as good as its aggregation key. Per-IP is cheap and available at the edge, but it conflates users behind a shared address and misses attackers who spread out. The action matters too: count mode is a measurement tool, not a protection. The rule has to be scoped, keyed, and thresholded against the actual traffic mix, then measured in count mode before it blocks.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "WAF logs: matched rule, aggregation key, request count, action, and the path. Sample the top source IPs and the top targeted accounts.",
      "Origin logs: login request rate, failure rate, account lockouts, and password-hashing latency. A blocked attack should reduce all four.",
      "False-positive reports: customer support tickets, synthetic login checks from known NAT egresses, and count-mode matches on legitimate traffic.",
      "Attack distribution: requests per IP, per account, and per user agent. A flat distribution across IPs is the signature of a distributed attempt.",
      "Rate-rule metrics: matches, blocks, challenges, and the count near the threshold. A rule that never matches is not protecting anything.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the false-positive rate and the attack pass-through together. If legitimate users are blocked, inspect the top source IPs for NAT and the rule scope. If the attack passes, inspect the per-IP distribution and the rule action. Do not lower the threshold without count-mode evidence; do not raise it without checking the login service capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the target: login path, account, session, or API key.",
      "Run the candidate rule in count mode and measure matches against known legitimate traffic.",
      "Scope the rule to the endpoint under attack and aggregate on the key the attacker cannot rotate cheaply.",
      "Set the threshold above the legitimate aggregate for that key and below the abusive rate.",
      "Enforce, monitor false positives and attack pass-through, and keep a rollback to count mode.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A strict per-IP limit stops simple floods and punishes shared NAT; a loose one misses distributed attacks.",
      "Login-only scope reduces collateral but leaves other endpoints unprotected and may miss attack traffic that uses a different path.",
      "Count mode gives you data but no protection; block mode protects but can create a customer incident if the threshold is wrong.",
      "Managed rule groups cover known patterns but add false positives and latency; custom rules fit the app but need maintenance.",
      "A challenge is often better than a block for ambiguous traffic, but it adds friction and depends on client capabilities.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "place-the-limit",
    question:
      "A credential-stuffing wave is exhausting the login service. Where do you enforce the limit, and what key do you aggregate on?",
    difficulty: 2,
    hints: [
      "The edge sees IP and path; the application sees the account.",
      "A per-IP key is cheap but shared.",
    ],
    answer:
      "I would enforce at the edge, scoped to the login endpoint, because that is where the abusive requests are concentrated and where blocking saves login CPU and database work. For the key, I would start with per-IP as a coarse ceiling but not rely on it alone: credential stuffing is often distributed, and a per-IP limit can miss it while punishing NAT users. I would add a per-account or per-session limit at the application or API gateway, where the targeted identity is visible, and a managed or bot rule for known automation patterns. I would run all new rules in count mode first, measure false positives against legitimate NAT traffic, and then enforce with a rollback path.",
    followUps: [
      "What would you do if the attack targets many accounts with one attempt each?",
      "How would you measure false positives before enforcement?",
      "Where does the account key come from before authentication?",
    ],
    redFlags: [
      "Blocks all login traffic.",
      "Uses only a per-IP limit and calls it done.",
      "Enforces without a count-mode baseline.",
    ],
    rubric: [
      "Chooses edge enforcement for compute protection.",
      "Explains per-IP blind spots and NAT collateral.",
      "Adds an identity or behavioral key.",
      "Names count mode and rollback.",
    ],
  },
  {
    id: "nat-false-positive",
    question:
      "Your new per-IP rule blocks 4% of legitimate login requests. The attack is stopped. What do you check, and what would you change?",
    difficulty: 2,
    hints: [
      "Look at the top source IPs.",
      "Scope and threshold are separate levers.",
    ],
    answer:
      "I would check whether the blocked legitimate requests come from a small number of shared NAT or proxy addresses. If so, the per-IP aggregate is above the threshold even though no individual user is abusive. I would compare the rule scope: if it counts all paths, browsing traffic is inflating the count, so scoping to login may fix it without weakening the attack coverage. If the scope is already correct, I would raise the threshold above the NAT aggregate, or move the enforcement to a per-account key for authenticated traffic. I would keep the rule in count mode long enough to confirm the false-positive rate before re-enforcing.",
    followUps: [
      "How would you distinguish a NAT from a botnet?",
      "What if the attack also comes from that NAT?",
      "How would you set the threshold from data?",
    ],
    redFlags: [
      "Raises the threshold until the attack passes.",
      "Ignores the source IP distribution.",
      "Removes the rule entirely.",
    ],
    rubric: [
      "Checks NAT and proxy concentration.",
      "Separates scope from threshold.",
      "Uses count mode to verify.",
      "Names an identity-based alternative.",
    ],
  },
  {
    id: "distributed-attack",
    question:
      "The attack sends 10 rps from each of 2,000 IPs. A 10 rps per-IP limit does not stop it. What are your options?",
    difficulty: 3,
    hints: [
      "The attacker controls the per-IP rate.",
      "The total and the target identity are still visible.",
    ],
    answer:
      "A per-IP ceiling is the wrong primary control for a flat distribution, because the attacker can shape each source to stay under it. I would aggregate on the target identity: account, session, or a combination of account and IP, and add a global or per-key ceiling to protect the login service. I would also use managed rules and bot signals that do not depend on rate, such as known credential-stuffing patterns, automation fingerprints, or impossible travel. If the service can tolerate it, a challenge is better than a block for ambiguous traffic. Finally, I would protect the login service with a queue or concurrency limit so a passing attack cannot consume every worker.",
    followUps: [
      "What if the attack targets 2,000 different accounts?",
      "How would you avoid blocking a shared corporate egress?",
      "What signal is available before authentication?",
    ],
    redFlags: [
      "Lowers the per-IP limit until NAT users are blocked.",
      "Relies only on rate.",
      "Adds origin capacity and calls it protection.",
    ],
    rubric: [
      "Explains why per-IP fails against a flat distribution.",
      "Adds an identity or behavioral control.",
      "Protects the login service with concurrency limits.",
      "Considers collateral damage.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The login endpoint has a WAF rule with a documented aggregation key and scope.",
      "New rules run in count mode long enough to measure legitimate matches.",
      "Dashboards show attack pass-through, false positives, login load, and p99 together.",
      "A rollback to count mode is one change, not a redeploy.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify whether the attack is concentrated or distributed across IPs.",
      "Check the top source IPs for NAT and the rule scope for unrelated traffic.",
      "Protect the login service with concurrency limits while tuning the edge rule.",
      "Keep blocked responses clear and avoid retry storms.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review count-mode matches against the final threshold.",
      "Add an identity-based or behavioral rule if the attack was distributed.",
      "Record the false-positive rate and the customer impact.",
      "Test the rule against a synthetic shared-NAT client.",
    ],
  },
];

const references = [
  {
    title: "Rate-based rule statement",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AWS WAF rate-based rules: aggregation keys, evaluation window, scope-down statements, and actions.",
  },
  {
    title: "Rate limiting rules",
    url: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Cloudflare rate limiting rule characteristics, counting periods, actions, and mitigation behavior.",
  },
  {
    title: "Web application firewall",
    url: "https://developers.cloudflare.com/waf/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Managed and custom WAF rules, rule evaluation, and the count-versus-block workflow.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "waf-rate-limits": {
      model: wafRateLimitsModel,
      presets,
      instructions:
        "Start Healthy, then apply Shared NAT to see a login-scoped rule catch legitimate users behind one address. Apply All-path overblock to widen the collateral. Run the experiment to see a distributed attack pass a per-IP threshold, then compare the count and block actions.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Source IP counts, NAT share, login capacity, and the five-minute window are teaching values, not provider guarantees. Real WAF rate rules have provider-specific minimums, windows, and aggregation options; verify them before production.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-rate-limiting",
    "traffic-edge-rate-limiting",
    "traffic-ddos-shield",
    "traffic-502-debug",
  ],
};
