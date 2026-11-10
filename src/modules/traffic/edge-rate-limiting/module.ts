import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ORIGIN_CAPACITY = 25_000;
const GLOBAL_LIMIT = 22_000;
const OTHER_KEYS = 19;
const USERS_PER_KEY = 1_000;
const NAT_SHARE = 0.25;
const BASE_LATENCY_MS = 60;

const params = [
  {
    id: "totalRps",
    label: "Total request rate",
    min: 5_000,
    max: 80_000,
    step: 1_000,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second across all API keys before any limit is applied.",
    format: "rps" as const,
  },
  {
    id: "topKeyShare",
    label: "Top API key share",
    min: 10,
    max: 95,
    step: 5,
    value: 20,
    unit: "%",
    group: "Traffic",
    help: "Share of traffic sent by the busiest key. The remaining keys split the rest evenly in this model.",
    format: "percent" as const,
  },
  {
    id: "perKeyLimit",
    label: "Per-key limit",
    min: 1_000,
    max: 40_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Limits",
    help: "Sustained rate allowed for each API key. A per-key limit isolates one tenant but can throttle a tenant with many users.",
    format: "rps" as const,
  },
  {
    id: "perIpLimit",
    label: "Per-IP limit",
    min: 10,
    max: 5_000,
    step: 10,
    value: 1_000,
    unit: " rps",
    group: "Limits",
    help: "Sustained rate allowed for one client IP. Shared NAT or proxy addresses aggregate many users under one IP.",
    format: "rps" as const,
  },
  {
    id: "natUsersPerIp",
    label: "Users behind one NAT IP",
    min: 1,
    max: 500,
    step: 1,
    value: 50,
    unit: "",
    group: "Client topology",
    help: "How many users share a single public address. The NAT IP's rate is the top key's per-user rate multiplied by this number.",
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
  totalRps: number;
  topKeyShare: number;
  perKeyLimit: number;
  perIpLimit: number;
  natUsersPerIp: number;
  topKeyRps: number;
  otherKeyRps: number;
  topAdmittedKey: number;
  otherAdmittedKey: number;
  afterKey: number;
  topUserRps: number;
  natIpRate: number;
  natBlocked: boolean;
  natBlockedShare: number;
  afterIp: number;
  globalAdmitted: number;
  blockedRps: number;
  throttled: number;
  natBlockedPct: number;
  topKeyAdmittedShare: number;
  originUtil: number;
  p99: number;
}

function compute(p: Params): Computed {
  const totalRps = Math.max(1, num(p, "totalRps", 12_000));
  const topKeyShare = clamp(num(p, "topKeyShare", 20), 0, 100) / 100;
  const perKeyLimit = Math.max(1, num(p, "perKeyLimit", 20_000));
  const perIpLimit = Math.max(1, num(p, "perIpLimit", 1_000));
  const natUsersPerIp = Math.max(1, Math.round(num(p, "natUsersPerIp", 50)));
  const topKeyRps = totalRps * topKeyShare;
  const otherKeyRps = (totalRps - topKeyRps) / OTHER_KEYS;
  const topAdmittedKey = Math.min(topKeyRps, perKeyLimit);
  const otherAdmittedKey = Math.min(otherKeyRps, perKeyLimit);
  const afterKey = topAdmittedKey + otherAdmittedKey * OTHER_KEYS;
  const topUserRps = topAdmittedKey / USERS_PER_KEY;
  const natIpRate = topUserRps * natUsersPerIp;
  const natBlocked = natUsersPerIp > 1 && natIpRate > perIpLimit;
  const natBlockedShare = natBlocked ? NAT_SHARE : 0;
  const topKeyAfterIp = topAdmittedKey * (1 - natBlockedShare);
  const afterIp = afterKey - topAdmittedKey * natBlockedShare;
  const globalAdmitted = Math.min(afterIp, GLOBAL_LIMIT);
  const blockedRps = Math.max(0, totalRps - globalAdmitted);
  const throttled = (blockedRps / totalRps) * 100;
  const natBlockedPct = (topAdmittedKey * natBlockedShare / totalRps) * 100;
  const topKeyAdmittedShare = (topKeyAfterIp / totalRps) * 100;
  const originUtil = (globalAdmitted / ORIGIN_CAPACITY) * 100;
  const ratio = globalAdmitted / ORIGIN_CAPACITY;
  const queueing = ratio > 0.85 ? Math.min(2_000, ((ratio - 0.85) / 0.15) * 120) : 0;
  const p99 = BASE_LATENCY_MS + queueing;
  return {
    totalRps,
    topKeyShare: topKeyShare * 100,
    perKeyLimit,
    perIpLimit,
    natUsersPerIp,
    topKeyRps,
    otherKeyRps,
    topAdmittedKey,
    otherAdmittedKey,
    afterKey,
    topUserRps,
    natIpRate,
    natBlocked,
    natBlockedShare,
    afterIp,
    globalAdmitted,
    blockedRps,
    throttled,
    natBlockedPct,
    topKeyAdmittedShare,
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
  const limiterHealth =
    d.natBlockedPct >= 5 || d.throttled >= 60
      ? "crit"
      : d.natBlockedPct >= 1 || d.throttled >= 30
        ? "warn"
        : "ok";
  const originHealth = healthFor(d.originUtil, 84, 100);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "API clients",
        kind: "client",
        health: "ok",
        throughput: d.totalRps,
        sublabel: `${formatCount(d.totalRps)} rps offered`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge rate limiter",
        kind: "lb",
        health: limiterHealth,
        utilization: clamp(d.globalAdmitted / 50_000),
        throughput: d.globalAdmitted,
        sublabel: `${formatCount(d.perKeyLimit)}/s per key · ${formatCount(d.perIpLimit)}/s per IP`,
        detail: `Top key offers ${formatCount(d.topKeyRps)} rps and is admitted at ${formatCount(d.topAdmittedKey)} rps. Its NAT address carries about ${formatCount(d.natIpRate)} rps across ${formatCount(d.natUsersPerIp)} users.`,
        meta: { view: "flow", natBlocked: d.natBlocked ? 1 : 0 },
      },
      {
        id: "origin",
        label: "API origin",
        kind: "service",
        health: originHealth,
        utilization: clamp(d.originUtil / 100),
        throughput: d.globalAdmitted,
        capacity: ORIGIN_CAPACITY,
        sublabel: `${formatCount(d.globalAdmitted)} rps admitted`,
        detail: `Illustrative origin capacity is ${formatCount(ORIGIN_CAPACITY)} rps. The global edge backstop is ${formatCount(GLOBAL_LIMIT)} rps.`,
        meta: { view: "flow" },
      },
      {
        id: "blocked",
        label: "Throttled traffic",
        kind: "external",
        health: "ok",
        throughput: d.blockedRps,
        sublabel: `${formatCount(d.blockedRps)} rps rejected`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", d.totalRps / 80_000, limiterHealth),
      edge("edge-origin", "edge", "origin", d.globalAdmitted / 80_000, originHealth),
      edge("edge-blocked", "edge", "blocked", d.blockedRps / 80_000, "ok"),
    ],
    metrics: [
      metric("origin-load", "Origin load", d.globalAdmitted, " rps", 21_000, 25_000, "rps"),
      metric("nat-blocked", "Legitimate NAT users blocked", d.natBlockedPct, "%", 1, 5, "percent"),
      metric("throttled", "Total traffic throttled", d.throttled, "%", 30, 60, "percent"),
      metric("p99", "API p99", d.p99, " ms", undefined, undefined, "ms"),
      metric("top-key-share", "Top key admitted share", d.topKeyAdmittedShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      perKeyLimit: d.perKeyLimit,
      perIpLimit: d.perIpLimit,
      natBlocked: d.natBlocked ? 1 : 0,
      throttled: d.throttled,
    },
    summary: `${formatCount(d.totalRps)} rps offered; top key ${formatCount(d.topKeyRps)} rps offered and ${formatCount(d.topAdmittedKey)} rps admitted; ${d.throttled.toFixed(1)}% throttled; ${d.natBlockedPct.toFixed(1)}% blocked by NAT; origin ${formatCount(d.globalAdmitted)} rps.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.04 * Math.sin((index + (seed % 6)) / 2.4)) + Math.sin(index / 2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "origin-load",
    metricId: "origin-load",
    warn: 21_000,
    crit: 25_000,
    title: "Origin load crossed the capacity line",
    cause:
      "The per-key and per-IP limits still admit more traffic than the origin can serve. A global limit is the last backstop, but it protects the origin by rejecting everyone rather than by isolating the abusive client.",
    fix:
      "Add a per-key limit for the tenant that dominates the traffic, keep the per-IP limit above the shared NAT aggregate, and set the global limit below origin capacity. Scale the origin only after the edge limits are effective.",
    checkFirst: [
      "Split origin load by API key and by source IP.",
      "Compare the global limit with the origin's measured safe capacity.",
      "Check whether the top key is abusive or simply a large legitimate tenant.",
    ],
  },
  {
    id: "nat-blocked",
    metricId: "nat-blocked",
    warn: 1,
    crit: 5,
    title: "A shared NAT is being throttled",
    cause:
      "The per-IP limit is below the aggregate rate of users behind one NAT or proxy address. Each individual user may be well within policy, but the shared address is treated as one client.",
    fix:
      "Raise the per-IP limit above the NAT aggregate, add a per-key limit for the tenant, or aggregate on an authenticated identity instead of the IP. Measure the NAT population before enforcing.",
    checkFirst: [
      "List the top source IPs and the number of distinct API keys or users behind each.",
      "Compare the per-IP limit with the observed NAT aggregate.",
      "Check whether the affected clients share a corporate egress or carrier NAT.",
    ],
  },
  {
    id: "throttled",
    metricId: "throttled",
    warn: 30,
    crit: 60,
    title: "A large share of traffic is being throttled",
    cause:
      "One key or the global limit is rejecting a large fraction of requests. Throttling the top key may be the intended fairness outcome, but it is still a product decision with a customer impact.",
    fix:
      "Decide whether the top key is abusive or a legitimate tenant with a quota problem. Raise its quota, move it to a dedicated capacity pool, or keep the limit and communicate the quota. Use a 429 with a retry hint and keep retries out of the same bucket.",
    checkFirst: [
      "Split throttled requests by API key and by limit type.",
      "Compare the top key's offered rate with its historical baseline.",
      "Check whether clients retry immediately and amplify the rejection rate.",
    ],
  },
];

export const edgeRateLimitingModel: SimModel = {
  id: "traffic-edge-rate-limiting",
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
    if (d.topKeyRps > d.perKeyLimit && frame.flags.topKeyLimited !== 1) {
      pushEvent(next, {
        id: "top-key-limited",
        at: frame.t,
        severity: "info",
        title: "The busiest API key reached its per-key limit",
        detail: `The top key offers ${formatCount(d.topKeyRps)} rps and is admitted at ${formatCount(d.topAdmittedKey)} rps. ${formatCount(d.topKeyRps - d.topAdmittedKey)} rps is rejected by the per-key limit.`,
        nodeId: "edge",
        metricId: "throttled",
      });
      next.flags.topKeyLimited = 1;
    }
    if (d.topKeyRps <= d.perKeyLimit) next.flags.topKeyLimited = 0;
    if (d.natBlockedPct >= 5 && frame.flags.natBlockedEvent !== 1) {
      pushEvent(next, {
        id: "nat-blocked",
        at: frame.t,
        severity: "crit",
        title: "Shared NAT traffic is being blocked",
        detail: `The top key's NAT address carries about ${formatCount(d.natIpRate)} rps across ${formatCount(d.natUsersPerIp)} users against a ${formatCount(d.perIpLimit)} rps per-IP limit. ${d.natBlockedPct.toFixed(1)}% of all traffic is blocked by the per-IP rule.`,
        nodeId: "edge",
        metricId: "nat-blocked",
      });
      next.flags.natBlockedEvent = 1;
    }
    if (d.natBlockedPct < 5) next.flags.natBlockedEvent = 0;
    if (d.afterIp > GLOBAL_LIMIT && frame.flags.globalLimitEvent !== 1) {
      pushEvent(next, {
        id: "global-limit",
        at: frame.t,
        severity: "warn",
        title: "The global edge backstop is active",
        detail: `${formatCount(d.afterIp)} rps passed the per-key and per-IP limits; the global limit admits ${formatCount(GLOBAL_LIMIT)} rps. This protects the origin but does not isolate the tenant causing the load.`,
        nodeId: "edge",
        metricId: "origin-load",
      });
      next.flags.globalLimitEvent = 1;
    }
    if (d.afterIp <= GLOBAL_LIMIT) next.flags.globalLimitEvent = 0;
    next.flags.perKeyLimit = d.perKeyLimit;
    next.flags.perIpLimit = d.perIpLimit;
    next.flags.natBlocked = d.natBlocked ? 1 : 0;
    next.flags.throttled = d.throttled;
    next.summary = `${formatCount(d.totalRps)} rps offered; top key ${formatCount(d.topKeyRps)} rps offered and ${formatCount(d.topAdmittedKey)} rps admitted; ${d.throttled.toFixed(1)}% throttled; ${d.natBlockedPct.toFixed(1)}% blocked by NAT; origin ${formatCount(d.globalAdmitted)} rps.`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `The top key offers ${formatCount(d.topKeyRps)} rps and is admitted at ${formatCount(d.topAdmittedKey)} rps. Its admitted share falls from ${d.topKeyShare.toFixed(0)}% to ${d.topKeyAdmittedShare.toFixed(1)}%.`,
    );
    items.push(
      `The per-IP rule sees about ${formatCount(d.natIpRate)} rps from one shared address across ${formatCount(d.natUsersPerIp)} users. The per-IP limit is ${formatCount(d.perIpLimit)} rps.`,
    );
    if (d.natBlocked) {
      items.push(
        "The NAT address crossed the per-IP limit. That blocks a group of legitimate users, not the API key that is actually sending the traffic.",
      );
    } else {
      items.push(
        "The NAT address stays below the per-IP limit. That is the only reason this per-IP setting is safe for shared clients.",
      );
    }
    if (d.afterIp > GLOBAL_LIMIT) {
      items.push(
        `The global limit admits ${formatCount(GLOBAL_LIMIT)} rps and rejects the rest. It protects the origin, but every tenant shares the rejection.`,
      );
    }
    items.push(
      `${d.throttled.toFixed(1)}% of traffic is rejected. Decide whether that is fairness for an abusive key or collateral for a large legitimate tenant.`,
    );
    return items;
  },
  legend: [
    { label: "Within limits", tone: "ok" },
    { label: "Throttled", tone: "warn" },
    { label: "NAT collateral", tone: "crit" },
    { label: "Rejected", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Balanced traffic, generous per-key and per-IP limits, and an origin below capacity.",
    tone: "ok",
    params: defaults({ totalRps: 12_000, topKeyShare: 20, perKeyLimit: 20_000, perIpLimit: 1_000, natUsersPerIp: 50 }),
  },
  {
    id: "peak",
    label: "Busy key",
    description: "The top key sends 60% of traffic. The per-key limit trims it and the global backstop is active.",
    tone: "warn",
    params: defaults({ totalRps: 30_000, topKeyShare: 60, perKeyLimit: 15_000, perIpLimit: 1_000, natUsersPerIp: 50 }),
  },
  {
    id: "failure",
    label: "NAT collateral",
    description: "A low per-IP limit blocks legitimate users behind a shared address while the per-key limit handles the hot tenant.",
    tone: "crit",
    params: defaults({ totalRps: 40_000, topKeyShare: 80, perKeyLimit: 10_000, perIpLimit: 100, natUsersPerIp: 50 }),
  },
  {
    id: "key-only",
    label: "Per-key only",
    description: "The per-key limit trims the top tenant and the per-IP limit is high enough for shared NAT.",
    tone: "warn",
    params: defaults({ totalRps: 40_000, topKeyShare: 80, perKeyLimit: 10_000, perIpLimit: 2_000, natUsersPerIp: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Traffic falls, the top key is below its limit, and the per-IP limit clears the NAT aggregate.",
    tone: "ok",
    params: defaults({ totalRps: 18_000, topKeyShare: 50, perKeyLimit: 10_000, perIpLimit: 1_000, natUsersPerIp: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-nat-collateral",
  title: "Predict what a per-IP limit does to a shared NAT",
  simId: "edge-rate-limiting",
  question:
    "One API key sends 80% of 40,000 rps. You add a per-IP limit of 100 rps. About 25% of legitimate users share a NAT address, with 50 users behind each one. What happens?",
  prediction: {
    options: [
      { id: "nat", label: "The NAT address is blocked, so legitimate users are throttled; the per-IP rule does not target the key." },
      { id: "key", label: "The top key is blocked because its traffic comes from one IP." },
      { id: "origin", label: "The origin load falls to zero because all traffic shares one IP." },
      { id: "nothing", label: "Nothing; the per-key limit handles the top key." },
    ],
    correctOptionId: "nat",
    explanation:
      "A per-IP limit aggregates every request from one public address. The top key's per-user rate is about 10 rps after the per-key limit; 50 users behind one NAT address multiply that to about 500 rps, well above 100. The rule blocks the shared address, which punishes legitimate users who happen to share it. The key that is actually sending 80% of the traffic is still handled by the per-key limit, not by the IP rule.",
  },
  setup: defaults({ totalRps: 40_000, topKeyShare: 80, perKeyLimit: 10_000, perIpLimit: 100, natUsersPerIp: 50 }),
  runFor: 20,
  observe: [
    "About 6.3% of all traffic is blocked by the per-IP rule, representing 25% of the top key's traffic behind NAT.",
    "The top key still offers 32,000 rps and is admitted at 10,000 rps by the per-key limit.",
    "Origin load falls to about 15,500 rps, but the per-IP rule is not what protected it.",
    "The NAT address sees about 500 rps against a 100 rps limit; individual users are far below it.",
  ],
  explain:
    "The per-IP limit is a proxy for a client, and a NAT address is a very poor proxy. It aggregates unrelated users into one bucket and blocks all of them when the bucket overflows. The per-key limit is the control that matches the abusive unit: one key sending 80% of traffic. A global limit protects the origin when both fail, but it shares the rejection across every tenant. The correct combination is a per-key quota for the hot tenant, a per-IP limit above the largest legitimate NAT aggregate, and a global backstop below origin capacity.",
  fix: defaults({ totalRps: 40_000, topKeyShare: 80, perKeyLimit: 10_000, perIpLimit: 1_000, natUsersPerIp: 50 }),
  debrief:
    "Raising the per-IP limit to 1,000 rps clears the NAT false positives, but the per-key limit still throttles the top tenant from 32,000 to 10,000 rps. That is the intended fairness outcome if the tenant is abusive, and a quota problem if it is legitimate. The global limit admits 18,000 rps, below the illustrative origin capacity. The tradeoff is explicit: per-key limits isolate a tenant, per-IP limits protect against individual clients but punish shared addresses, and global limits protect the origin at everyone's expense.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Edge rate limiting rejects or delays requests before they reach the origin. A limit has an aggregation key, a rate, a window, and an action. The key can be an API key, an IP address, a tenant, a route, or a global bucket. The rate can be enforced with a token bucket, a fixed window, or a sliding window. The action is usually a 429 response, sometimes with a `Retry-After` hint, or a queue if the client can wait. The limit is only as fair as its key: a key that groups unrelated clients turns one client's abuse into everyone's outage.",
  },
  {
    type: "p",
    text: "Three limits solve different problems. A per-key limit is a tenant quota: it isolates one API key that dominates traffic, and it can throttle a legitimate tenant with many users. A per-IP limit is a client ceiling: it stops one source from flooding the edge, but a NAT, corporate proxy, or mobile carrier can put thousands of users behind one address. A global limit is a backstop: it protects the origin from the sum of all traffic, but it rejects across every tenant and does not identify the abuser.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge limiter, origin. The edge can enforce on the API key in a header, the source IP, the route, or a combination. It usually cannot see the end user behind an API key, and it cannot tell a NAT from a botnet by address alone. That is why limits are often layered: a per-key quota at the edge, a per-IP ceiling for unauthenticated routes, a per-account limit at the application, and a global concurrency limit at the origin. Each layer covers a different unit of abuse.",
  },
  {
    type: "compare",
    leftTitle: "Per-key limit",
    rightTitle: "Per-IP limit",
    rows: [
      { label: "Unit", left: "One API key or tenant", right: "One source address" },
      { label: "Stops", left: "One tenant consuming shared capacity", right: "One host or small botnet flooding the edge" },
      { label: "Blind spot", left: "Abuse spread across many keys", right: "Distributed clients and shared NAT" },
      { label: "Collateral", left: "A large legitimate tenant with many users", right: "Every user behind the same NAT or proxy" },
    ],
  },
  {
    type: "p",
    text: "The global limit is the backstop, not the primary control. It is the only limit that directly maps to origin capacity, and it is the least fair: when it fires, every tenant shares the rejection. A global limit is useful when the origin must be protected at all costs, but it should sit below the origin's measured safe rate and above the sum of the per-key quotas you intend to allow.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Origin load and p99, the capacity the limits are supposed to protect.",
      "Total throttled traffic, which includes intentional quota enforcement and collateral.",
      "Legitimate NAT users blocked, the false-positive signal that a per-IP limit is too tight.",
      "Top-key admitted share, which shows whether the limit actually changed the concentration.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Busy key to see the per-key limit trim the top tenant. Apply NAT collateral to see a low per-IP limit block shared addresses while the per-key rule does the real work. Apply Per-key only to compare the same load without NAT damage. Run the experiment to see the NAT aggregate calculation.",
  },
  {
    type: "table",
    headers: ["Limit", "Protects", "Punishes", "Use when"],
    rows: [
      ["Per-key", "Shared origin capacity from one tenant", "A legitimate tenant with many users", "One key dominates traffic"],
      ["Per-IP", "The edge from one source", "NAT, proxies, mobile carriers", "Sources are diverse and mostly unauthenticated"],
      ["Per-account", "One identity from credential abuse", "Shared or family accounts", "The application knows the account before the work"],
      ["Global", "The origin from the sum of all traffic", "Every tenant during a spike", "You need a hard capacity backstop"],
    ],
  },
  {
    type: "p",
    text: "The first question is which unit is actually consuming the capacity. If one API key sends 80% of the traffic, a per-IP limit is aimed at the wrong thing. The second question is who shares the key or address. A per-key limit is fair only if the key maps to a tenant that can manage its own usage; a per-IP limit is fair only if the address maps to one client. When neither mapping holds, the limit needs a better key, not a tighter threshold.",
  },
  { type: "sim", simId: "edge-rate-limiting" },
  { type: "experiment", experimentId: "predict-nat-collateral" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset set a 100 rps per-IP limit while the top key sent 80% of 40,000 rps. The per-key limit trimmed the key to 10,000 rps, but the per-IP rule still saw about 500 rps from one NAT address and blocked it. That removed about 6% of all traffic, all of it legitimate users who happened to share an address. The top key was not blocked by the per-IP rule; it was already handled by the per-key limit. Raising the per-IP limit cleared the collateral, and the per-key limit continued to throttle the hot tenant.",
  },
  {
    type: "p",
    text: "The global limit then admitted 18,000 rps, below the illustrative origin capacity, but it also rejected 55% of offered traffic because the top key was capped. That is the fairness trade: the origin is protected, the abusive or large tenant is contained, and the rejection is visible. The design question is not how to eliminate throttling; it is which unit should absorb it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Edge logs: the limit that fired, the aggregation key, the admitted and rejected counts, and the client identity. Split by key and by IP.",
      "Origin metrics: request rate, concurrency, p99, and 5xx. The edge limit should reduce all four when it targets the right unit.",
      "Client feedback: 429 rate, `Retry-After` behavior, and retry volume. Immediate retries turn a limit into a larger rejection rate.",
      "NAT evidence: the number of distinct API keys or users behind the top source IPs. A single IP with many keys is a shared egress, not one client.",
      "Quota history: the top key's baseline and growth. A sudden spike is different from a tenant that has simply outgrown its plan.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split throttled traffic by limit type and by key before changing a threshold. If the per-IP limit is firing, count the distinct keys behind the top addresses. If the per-key limit is firing, compare the key's offered rate with its baseline. Do not raise a limit just to clear an alert; decide whether the tenant is abusive or under-provisioned.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the unit consuming capacity: one key, one IP, one account, or the total.",
      "Set a per-key quota for the dominant tenant and confirm it matches the commercial quota.",
      "Set the per-IP limit above the largest legitimate NAT aggregate, or remove it for authenticated routes.",
      "Set a global backstop below origin capacity so a missed limit cannot take down the service.",
      "Return 429 with a retry hint, keep retries out of the same bucket, and monitor false positives after rollout.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Per-key limits isolate a tenant and can throttle a legitimate one; the quota has to match the contract.",
      "Per-IP limits stop individual floods but punish NAT, proxies, and mobile carriers.",
      "Global limits protect the origin at everyone's expense and do not identify the abusive client.",
      "A tight limit protects capacity but creates a customer incident if the baseline is wrong.",
      "A loose limit avoids collateral but lets one tenant consume the shared pool until the origin saturates.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-limit",
    question:
      "One API key sends 80% of traffic and the origin is saturated. Which limit do you add first, and what do you measure?",
    difficulty: 2,
    hints: [
      "Match the limit to the unit consuming capacity.",
      "A per-IP limit sees a different unit than a per-key limit.",
    ],
    answer:
      "I would add a per-key limit first because the key is the unit consuming the capacity. I would set it from the tenant's contract or a measured fair share, not from the origin's total capacity, and I would measure the key's admitted share, origin load, and the rejected rate. Then I would check whether other keys are also large enough to need quotas. A per-IP limit would be secondary: it can catch a single host, but it does not target an API key that may be spread across many addresses, and it can block a shared NAT. A global limit belongs at the origin as a backstop, not as the primary fairness control.",
    followUps: [
      "What if the top key is a legitimate customer?",
      "How would you set the per-key threshold?",
      "When would a per-IP limit still be necessary?",
    ],
    redFlags: [
      "Adds a per-IP limit first.",
      "Sets the key limit from total origin capacity.",
      "Ignores the customer contract.",
    ],
    rubric: [
      "Matches the limit to the consuming unit.",
      "Measures admitted share and origin load.",
      "Names the NAT tradeoff.",
      "Places the global limit as a backstop.",
    ],
  },
  {
    id: "nat-collateral",
    question:
      "A per-IP limit is blocking legitimate users. How do you confirm it is a NAT problem, and what do you change?",
    difficulty: 2,
    hints: [
      "Count distinct keys or users per source IP.",
      "The per-IP limit and the per-key limit are different controls.",
    ],
    answer:
      "I would count distinct API keys, accounts, or user agents behind the top blocked IPs. A single address with many distinct keys is a shared egress, not one client. I would compare the address's aggregate rate with the per-IP limit and with the per-user rate. The fix is to raise the per-IP limit above the legitimate aggregate, remove it for authenticated routes, or move the enforcement to a per-key or per-account limit. I would keep the per-IP rule for unauthenticated or clearly single-client routes, and measure the false-positive rate in count mode before re-enforcing.",
    followUps: [
      "How would you distinguish a NAT from a botnet using the same address?",
      "What if the NAT also carries the attack?",
      "How would you set the per-IP limit from data?",
    ],
    redFlags: [
      "Raises the limit until the alert stops.",
      "Removes all limits.",
      "Assumes one IP equals one user.",
    ],
    rubric: [
      "Counts distinct identities per IP.",
      "Separates NAT from abuse.",
      "Moves enforcement to a better key.",
      "Uses count mode to verify.",
    ],
  },
  {
    id: "global-backstop",
    question:
      "Why have a global limit if per-key and per-IP limits already exist?",
    difficulty: 3,
    hints: [
      "The sum of per-key quotas can exceed origin capacity.",
      "A backstop is deliberately unfair.",
    ],
    answer:
      "The per-key and per-IP limits are fairness controls; the global limit is a capacity backstop. The sum of the per-key quotas can exceed what the origin can serve, especially during a traffic shift or a new tenant ramp. A global limit guarantees the origin never sees more than its safe rate, even if every individual key is within its quota. The cost is that it rejects across all tenants and does not identify the abusive one, so it should sit below origin capacity and above the sum of quotas you intend to allow. It is the last line, not the first.",
    followUps: [
      "How would you set the global limit?",
      "What happens when the global limit fires?",
      "How would you avoid retry amplification?",
    ],
    redFlags: [
      "Uses the global limit as the primary fairness control.",
      "Sets it above origin capacity.",
      "Ignores the sum of per-key quotas.",
    ],
    rubric: [
      "Distinguishes fairness from capacity.",
      "Explains quota oversubscription.",
      "Places the limit below origin capacity.",
      "Names the fairness cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The dominant traffic unit is known: key, IP, account, or total.",
      "Per-key quotas match the commercial contract and the origin's safe capacity.",
      "The per-IP limit is above the largest legitimate NAT aggregate.",
      "A global backstop exists below origin capacity, and 429 responses carry a retry hint.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split throttled traffic by limit type and by key.",
      "Count distinct identities behind the top source IPs before changing the per-IP limit.",
      "Check whether the top key is abusive or a legitimate tenant that outgrew its quota.",
      "Watch origin load and p99 after each limit change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review the per-key quota against the tenant's baseline.",
      "Test the limit with a synthetic shared-NAT client.",
      "Add retry guidance and backoff to client SDKs.",
      "Document the global limit and the origin capacity it protects.",
    ],
  },
];

const references = [
  {
    title: "Rate limiting rules",
    url: "https://developers.cloudflare.com/waf/rate-limiting-rules/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Rate limiting characteristics, counting periods, actions, and mitigation behavior.",
  },
  {
    title: "Rate-based rule statement",
    url: "https://docs.aws.amazon.com/waf/latest/developerguide/waf-rule-statement-type-rate-based.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AWS WAF rate-based rules, aggregation keys, evaluation windows, and scope-down statements.",
  },
  {
    title: "HTTP 429 Too Many Requests",
    url: "https://www.rfc-editor.org/rfc/rfc6585",
    publisher: "IETF",
    kind: "standard" as const,
    note: "The 429 status code and the Retry-After header for rate-limited clients.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "edge-rate-limiting": {
      model: edgeRateLimitingModel,
      presets,
      instructions:
        "Start Healthy, then apply Busy key to see the per-key limit trim the top tenant. Apply NAT collateral to see a low per-IP limit block shared addresses. Apply Per-key only to compare the same load without NAT damage.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Key counts, NAT share, origin capacity, and the global backstop are teaching values, not provider guarantees. Real limits depend on the provider's aggregation options and the customer's topology.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-waf-rate-limits",
    "foundations-rate-limiting",
    "traffic-anycast",
    "traffic-ddos-shield",
  ],
};
