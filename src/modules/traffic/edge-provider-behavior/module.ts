import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUEST_RATE = 20_000;
const OBJECT_COUNT = 500;
const CACHE_CAPACITY = 20_000;
const FULL_QUERY_VARIANTS = 40;
const NORMALIZED_VARIANTS = 3;
const CHANGED_OBJECTS = 50;
const DEPLOY_INTERVAL = 3_600;
const ORIGIN_CAPACITY = 8_000;
const MAX_HIT = 99.5;

const PROFILES = [
  {
    label: "Cloudflare",
    tagPurgeSeconds: 30,
    urlPurgeSeconds: 45,
    hostPurgeSeconds: 60,
    rulePenalty: 50,
  },
  {
    label: "Akamai",
    tagPurgeSeconds: 60,
    urlPurgeSeconds: 90,
    hostPurgeSeconds: 120,
    rulePenalty: 70,
  },
];

const params = [
  {
    id: "provider",
    label: "Provider (0 Cloudflare, 1 Akamai)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Provider",
    help: "Switches the provider profile in this model. The profiles use illustrative purge propagation times and rule-order penalties; verify current behavior in each provider's documentation.",
    format: "count" as const,
  },
  {
    id: "ttlSeconds",
    label: "Cache TTL",
    min: 60,
    max: 86_400,
    step: 60,
    value: 3_600,
    unit: " s",
    group: "Freshness",
    help: "Freshness lifetime configured for the HTML object. A URL purge only covers the exact URL, so uncovered variants stay stale until the TTL.",
    format: "number" as const,
  },
  {
    id: "purgeScope",
    label: "Purge scope (0 URL, 1 tag/CP code, 2 host)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Purge",
    help: "Zero purges one URL, one purges a cache tag or CP code, and two purges the host. Broader scopes cover more variants and create a larger refetch.",
    format: "count" as const,
  },
  {
    id: "keyMode",
    label: "Cache key (0 provider default, 1 normalized)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Cache key",
    help: "Provider default includes the full query string in this model. Normalized strips tracking parameters and keeps meaningful variants.",
    format: "count" as const,
  },
  {
    id: "ruleOrder",
    label: "Rule order (0 cache before redirect, 1 redirect before cache)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Rules",
    help: "When a redirect or rewrite runs before the cache lookup, the cache stores a different key from the public URL and a purge can miss it.",
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
  provider: number;
  providerLabel: string;
  ttl: number;
  purgeScope: number;
  keyMode: number;
  ruleOrder: number;
  variants: number;
  keyCount: number;
  hitRate: number;
  missRate: number;
  purgeLag: number;
  staleRate: number;
  originRps: number;
  originUtil: number;
  purgedObjects: number;
  scopeLabel: string;
}

function compute(p: Params): Computed {
  const provider = Math.round(clamp(num(p, "provider", 0), 0, 1));
  const profile = PROFILES[provider];
  const ttl = Math.max(1, num(p, "ttlSeconds", 3_600));
  const purgeScope = Math.round(clamp(num(p, "purgeScope", 1), 0, 2));
  const keyMode = Math.round(clamp(num(p, "keyMode", 1), 0, 1));
  const ruleOrder = Math.round(clamp(num(p, "ruleOrder", 0), 0, 1));
  const variants = keyMode === 0 ? FULL_QUERY_VARIANTS : NORMALIZED_VARIANTS;
  const keyCount = OBJECT_COUNT * variants;
  const hitRate = Math.min(MAX_HIT, (CACHE_CAPACITY / (CACHE_CAPACITY + keyCount)) * 100);
  const missRate = 100 - hitRate;
  const purgeLag =
    purgeScope === 0
      ? profile.urlPurgeSeconds
      : purgeScope === 1
        ? profile.tagPurgeSeconds
        : profile.hostPurgeSeconds;
  const baseStale = (purgeLag / DEPLOY_INTERVAL) * 100;
  const uncovered = (keyCount - OBJECT_COUNT) / keyCount;
  const urlPenalty = purgeScope === 0 ? uncovered * 100 * Math.min(1, ttl / DEPLOY_INTERVAL) : 0;
  const rulePenalty = ruleOrder === 1 ? profile.rulePenalty : 0;
  const staleRate = Math.min(hitRate, baseStale + urlPenalty + rulePenalty);
  const purgedObjects =
    purgeScope === 0
      ? CHANGED_OBJECTS
      : purgeScope === 1
        ? CHANGED_OBJECTS * variants
        : OBJECT_COUNT * variants;
  const purgeRefreshRps = purgedObjects / DEPLOY_INTERVAL;
  const missRps = REQUEST_RATE * (missRate / 100);
  const originRps = Math.min(REQUEST_RATE, missRps + purgeRefreshRps);
  const originUtil = (originRps / ORIGIN_CAPACITY) * 100;
  const scopeLabel = purgeScope === 0 ? "URL purge" : purgeScope === 1 ? "tag / CP code purge" : "host purge";
  return {
    provider,
    providerLabel: profile.label,
    ttl,
    purgeScope,
    keyMode,
    ruleOrder,
    variants,
    keyCount,
    hitRate,
    missRate,
    purgeLag,
    staleRate,
    originRps,
    originUtil,
    purgedObjects,
    scopeLabel,
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

function worst(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function buildFrame(d: Computed, seed: number): SimFrame {
  const missHealth = healthFor(d.missRate, 20, 40);
  const staleHealth = healthFor(d.staleRate, 3, 8);
  const lagHealth = healthFor(d.purgeLag, 50, 120);
  const edgeHealth = worst(worst(missHealth, staleHealth), lagHealth);
  const originHealth = healthFor(d.originUtil, 70, 90);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: REQUEST_RATE,
        sublabel: `${formatCount(REQUEST_RATE)} rps offered`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: `${d.providerLabel} edge`,
        kind: "cdn",
        health: edgeHealth,
        utilization: clamp(d.staleRate / 100),
        throughput: REQUEST_RATE,
        sublabel: `${d.hitRate.toFixed(1)}% hit · ${d.staleRate.toFixed(1)}% stale`,
        detail: `${d.scopeLabel} with about ${formatCount(d.purgeLag)}s propagation in this model. Key mode: ${d.keyMode === 0 ? "provider default (full query)" : "normalized"}. Rule order: ${d.ruleOrder === 0 ? "cache before redirect" : "redirect before cache"}.`,
        meta: { view: "flow", provider: d.provider, stale: d.staleRate },
      },
      {
        id: "origin",
        label: "Origin",
        kind: "service",
        health: originHealth,
        utilization: clamp(d.originUtil / 100),
        throughput: d.originRps,
        capacity: ORIGIN_CAPACITY,
        sublabel: `${formatCount(d.originRps)} rps from misses`,
        detail: `Illustrative origin capacity is ${formatCount(ORIGIN_CAPACITY)} rps. A ${d.scopeLabel.toLowerCase()} refetches ${formatCount(d.purgedObjects)} objects per deploy in this model.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", REQUEST_RATE / 50_000, edgeHealth),
      edge("edge-origin", "edge", "origin", d.originRps / 50_000, originHealth),
    ],
    metrics: [
      metric("hit-rate", "Cache hit rate", d.hitRate, "%", undefined, undefined, "percent"),
      metric("miss-rate", "Cache miss rate", d.missRate, "%", 20, 40, "percent"),
      metric("stale-rate", "Stale responses", d.staleRate, "%", 3, 8, "percent"),
      metric("origin-rps", "Origin requests", d.originRps, " rps", 4_000, 6_000, "rps"),
      metric("purge-lag", "Purge propagation", d.purgeLag, " s", 50, 120, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      provider: d.provider,
      purgeScope: d.purgeScope,
      keyMode: d.keyMode,
      ruleOrder: d.ruleOrder,
      staleRate: d.staleRate,
    },
    summary: `${d.providerLabel}: ${d.hitRate.toFixed(1)}% hit over ${formatCount(d.keyCount)} keys; ${d.staleRate.toFixed(1)}% stale; ${formatCount(d.originRps)} rps to origin; purge propagation ${formatCount(d.purgeLag)}s.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.04 * Math.sin((index + (seed % 7)) / 2.3)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "miss-rate",
    metricId: "miss-rate",
    warn: 20,
    crit: 40,
    title: "Cache miss rate crossed the limit",
    cause:
      "The cache key includes the full query string, so tracking parameters and other variations create separate entries. The same intent produces different hit rates when the key is translated differently on the new provider.",
    fix:
      "Translate the key explicitly: list the query parameters and headers that change the response, exclude marketing parameters, and verify the resulting key count with a test request. Do not assume the old provider's default carries over.",
    checkFirst: [
      "Compare key count with object count and with the old provider's key count.",
      "Inspect the custom cache key settings for query string, headers, cookies, and host.",
      "Send two requests that differ only in a tracking parameter and compare the cache status.",
    ],
  },
  {
    id: "stale-rate",
    metricId: "stale-rate",
    warn: 3,
    crit: 8,
    title: "The ported configuration is serving stale content",
    cause:
      "A purge scope that covered every variant on one provider may cover only one URL on the other. A redirect or rewrite before the cache lookup can also store a different key from the public URL, so the purge misses it.",
    fix:
      "Use a purge scope that matches the cache key, or change the object identity with versioned URLs. Put the cache lookup before the redirect, or purge the rewritten key as well as the public URL.",
    checkFirst: [
      "Check whether the purge scope covers query variants, headers, and rewritten paths.",
      "Test the rule order with a request that matches both a redirect and a cache rule.",
      "Compare the cached `Age` and the purge completion time in several regions.",
    ],
  },
  {
    id: "origin-rps",
    metricId: "origin-rps",
    warn: 4_000,
    crit: 6_000,
    title: "The origin is absorbing the translation gap",
    cause:
      "A fragmented key or a purge that invalidates too much sends more requests to the origin. The origin is the symptom; the provider configuration is the cause.",
    fix:
      "Fix the key and purge scope before adding origin capacity. A broader purge can also cause a refetch spike; prefer cache tags or versioned URLs over host-wide purges.",
    checkFirst: [
      "Split origin requests by cache status and path.",
      "Check whether the spike follows a deploy or a configuration change.",
      "Compare the old and new provider's key counts and purge scopes.",
    ],
  },
  {
    id: "purge-lag",
    metricId: "purge-lag",
    warn: 50,
    crit: 120,
    title: "Purge propagation is slower than the release window",
    cause:
      "Purge is asynchronous on both providers. A larger scope or a slower propagation path can leave some edge locations serving the old object after the deploy.",
    fix:
      "Shorten the dependency on purge with versioned URLs, verify propagation with regional checks, and avoid host-wide purges for a small change. The provider's documented propagation behavior is the starting point, not a guarantee.",
    checkFirst: [
      "Check the purge request status and the time to the first and last region.",
      "Compare the purge scope with the set of objects that changed.",
      "Check whether a second deploy landed before the first purge finished.",
    ],
  },
];

export const edgeProviderBehaviorModel: SimModel = {
  id: "traffic-edge-provider-behavior",
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
    const noise = rng.between(-0.0005, 0.0005);
    const hitRate = Math.max(0, Math.min(MAX_HIT, d.hitRate + noise * 100));
    const missRate = 100 - hitRate;
    const staleRate = Math.min(hitRate, d.staleRate);
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
      item.id === "hit-rate"
        ? { ...item, value: hitRate }
        : item.id === "miss-rate"
          ? { ...item, value: missRate }
          : item.id === "stale-rate"
            ? { ...item, value: staleRate }
            : item,
    );
    const previousProvider = Number(frame.flags.provider ?? d.provider);
    const previousScope = Number(frame.flags.purgeScope ?? d.purgeScope);
    const previousKeyMode = Number(frame.flags.keyMode ?? d.keyMode);
    const previousRuleOrder = Number(frame.flags.ruleOrder ?? d.ruleOrder);
    if (d.provider !== previousProvider) {
      pushEvent(next, {
        id: "provider-change",
        at: frame.t,
        severity: "info",
        title: `Provider profile changed to ${d.providerLabel}`,
        detail: `Purge propagation is about ${formatCount(d.purgeLag)}s for a ${d.scopeLabel.toLowerCase()} in this model. Re-verify the key, purge scope, and rule order; the intent does not port automatically.`,
        nodeId: "edge",
        metricId: "purge-lag",
      });
    }
    if (d.purgeScope !== previousScope) {
      pushEvent(next, {
        id: "purge-scope-change",
        at: frame.t,
        severity: d.purgeScope === 2 ? "warn" : "info",
        title: `Purge scope changed to ${d.scopeLabel.toLowerCase()}`,
        detail: `The purge now covers ${formatCount(d.purgedObjects)} objects per deploy. A URL purge is precise but can miss query variants; a host purge is broad and can create a refetch spike.`,
        nodeId: "edge",
        metricId: "stale-rate",
      });
    }
    if (d.keyMode !== previousKeyMode) {
      pushEvent(next, {
        id: "key-mode-change",
        at: frame.t,
        severity: "info",
        title: d.keyMode === 0 ? "Cache key uses the full query string" : "Cache key normalized",
        detail:
          d.keyMode === 0
            ? `The key count is about ${formatCount(d.keyCount)}. Tracking parameters fragment the cache.`
            : `The key count is about ${formatCount(d.keyCount)} after keeping meaningful variants and stripping tracking parameters.`,
        nodeId: "edge",
        metricId: "miss-rate",
      });
    }
    if (d.ruleOrder !== previousRuleOrder) {
      pushEvent(next, {
        id: "rule-order-change",
        at: frame.t,
        severity: d.ruleOrder === 1 ? "warn" : "info",
        title: d.ruleOrder === 1 ? "Redirect runs before cache lookup" : "Cache lookup runs before redirect",
        detail:
          d.ruleOrder === 1
            ? "The cache may store a key derived from the rewritten URL. A purge by the public URL can miss it."
            : "The cache lookup uses the public URL, so a purge by that URL reaches the stored object.",
        nodeId: "edge",
        metricId: "stale-rate",
      });
    }
    if (d.staleRate >= 8 && frame.flags.staleDeploy !== 1) {
      pushEvent(next, {
        id: "stale-deploy",
        at: frame.t,
        severity: "crit",
        title: "The ported rule is serving stale content",
        detail: `${staleRate.toFixed(0)}% of responses are stale after deploy. ${d.providerLabel} with a ${d.scopeLabel.toLowerCase()} leaves about ${formatCount(d.purgeLag)}s of propagation in this model.`,
        nodeId: "edge",
        metricId: "stale-rate",
      });
      next.flags.staleDeploy = 1;
    }
    if (d.staleRate < 8) next.flags.staleDeploy = 0;    if (d.originRps >= ORIGIN_CAPACITY && frame.flags.originOverload !== 1) {
      pushEvent(next, {
        id: "origin-overload",
        at: frame.t,
        severity: "crit",
        title: "Origin request rate reached the illustrative capacity",
        detail: `${formatCount(d.originRps)} rps is reaching the origin against an illustrative capacity of ${formatCount(ORIGIN_CAPACITY)} rps.`,
        nodeId: "origin",
        metricId: "origin-rps",
      });
      next.flags.originOverload = 1;
    }
    if (d.originRps < ORIGIN_CAPACITY) next.flags.originOverload = 0;
    next.flags.provider = d.provider;
    next.flags.purgeScope = d.purgeScope;
    next.flags.keyMode = d.keyMode;
    next.flags.ruleOrder = d.ruleOrder;
    next.flags.staleRate = staleRate;
    next.summary = `${d.providerLabel}: ${hitRate.toFixed(1)}% hit over ${formatCount(d.keyCount)} keys; ${staleRate.toFixed(1)}% stale; ${formatCount(d.originRps)} rps to origin; purge propagation ${formatCount(d.purgeLag)}s.`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `${d.providerLabel} with a ${d.scopeLabel.toLowerCase()} propagates in about ${formatCount(d.purgeLag)}s in this model. The same intent on the other profile uses a different propagation path.`,
    );
    items.push(
      `${formatCount(d.keyCount)} keys from ${formatCount(OBJECT_COUNT)} paths because the key mode is ${d.keyMode === 0 ? "the provider default with the full query string" : "normalized"}.`,
    );
    if (d.purgeScope === 0 && d.variants > 1) {
      items.push(
        "A URL purge covers one URL, not every query variant. The uncovered variants remain stale until the TTL. That is a scope mismatch, not a slow purge.",
      );
    }
    if (d.ruleOrder === 1) {
      items.push(
        "The redirect runs before the cache lookup, so the cached key can differ from the public URL. A purge by the public URL may miss the stored object.",
      );
    }
    if (d.staleRate > 0) {
      items.push(
        `${d.staleRate.toFixed(1)}% of responses are stale. ${formatCount(d.staleRate * REQUEST_RATE / 100)} rps is affected at ${formatCount(REQUEST_RATE)} rps offered.`,
      );
    }
    items.push(
      `The origin sees ${formatCount(d.originRps)} rps. If that rose after the migration, check the key and purge scope before adding capacity.`,
    );
    return items;
  },
  legend: [
    { label: "Fresh", tone: "ok" },
    { label: "Propagation", tone: "warn" },
    { label: "Stale content", tone: "crit" },
    { label: "Refetch", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Cloudflare with normalized keys, a tag purge, and cache lookup before redirect.",
    tone: "ok",
    params: defaults({ provider: 0, ttlSeconds: 3_600, purgeScope: 1, keyMode: 1, ruleOrder: 0 }),
  },
  {
    id: "peak",
    label: "Akamai tag purge",
    description: "The same intent on Akamai. The key and scope are correct; purge propagation is slower.",
    tone: "warn",
    params: defaults({ provider: 1, ttlSeconds: 3_600, purgeScope: 1, keyMode: 1, ruleOrder: 0 }),
  },
  {
    id: "failure",
    label: "Ported rule",
    description: "A URL purge, full query key, and redirect before cache: the ported rule serves stale content.",
    tone: "crit",
    params: defaults({ provider: 1, ttlSeconds: 86_400, purgeScope: 0, keyMode: 0, ruleOrder: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Cloudflare with normalized keys, tag purge, and cache lookup before redirect.",
    tone: "ok",
    params: defaults({ provider: 0, ttlSeconds: 600, purgeScope: 1, keyMode: 1, ruleOrder: 0 }),
  },
  {
    id: "ported",
    label: "Same config, other provider",
    description: "The healthy Cloudflare configuration moved to Akamai without translating propagation or rule order.",
    tone: "warn",
    params: defaults({ provider: 1, ttlSeconds: 3_600, purgeScope: 1, keyMode: 1, ruleOrder: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-portability",
  title: "Predict why the ported rule serves stale content",
  simId: "edge-provider-behavior",
  question:
    "A cache rule works on Cloudflare. The same intent is configured on Akamai, but users see stale HTML after a deploy. The TTL and origin capacity are unchanged. What do you check first?",
  prediction: {
    options: [
      { id: "semantics", label: "The cache key, purge scope, and rule order: the same intent can map to different keys and different invalidation coverage." },
      { id: "origin", label: "Origin capacity: Akamai needs more origin servers." },
      { id: "dns", label: "DNS TTL: the new edge locations have not propagated." },
      { id: "ttl", label: "The TTL is ignored by every provider, so only a purge can help." },
    ],
    correctOptionId: "semantics",
    explanation:
      "The intent is portable; the implementation is not. A query string that is part of the key on one provider may be normalized or excluded on the other. A tag or path purge may cover every variant on one platform and only one URL on the other. A redirect or rewrite before the cache lookup can change the key that is stored, so a purge by the public URL misses it. The first check is the actual key and the actual purge coverage, verified with a test request, not the dashboard label.",
  },
  setup: defaults({ provider: 1, ttlSeconds: 86_400, purgeScope: 0, keyMode: 0, ruleOrder: 1 }),
  runFor: 20,
  observe: [
    "Hit rate is about 50% because the full query string creates about 20,000 keys.",
    "About half of responses are stale: a URL purge covers one URL, and the redirect changes the cached key.",
    "Origin requests reach about 10,000 rps, above the illustrative capacity.",
    "Switching to normalized keys, a tag purge, cache-before-redirect, and a 10-minute TTL drops stale responses below 2%.",
  ],
  explain:
    "The migration preserved the words of the rule, not its behavior. The key had been normalized on Cloudflare; on Akamai the default key kept the full query string. The purge had been a tag purge; the new configuration used a URL purge, which covers one variant. The redirect was placed before the cache lookup, so the stored key was derived from the rewritten URL. Each of those is a semantic difference, and each has to be tested against the cache status and the purge completion, not inferred from the configuration name.",
  fix: defaults({ provider: 1, ttlSeconds: 600, purgeScope: 1, keyMode: 1, ruleOrder: 0 }),
  debrief:
    "With normalized keys, a tag purge, cache-before-redirect, and a 10-minute TTL, stale responses fall below 2% and origin requests return to about 1,400 rps. The TTL change is a secondary bound: the tag purge and normalized key do the main work, while the shorter TTL limits how long an uncovered key can survive. A purge propagation warning remains because the Akamai profile is slower in this model; that is a documented operational cost, not a stale-content failure. The lesson is to port the behavior, then verify the key, the purge coverage, and the rule order with real requests in every region.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A CDN's cache behavior is the combination of four things: how it derives the cache key, how long it keeps an object, how a purge is scoped and propagated, and where the cache rule sits in the request-processing order. Cloudflare and Akamai implement all four, but the configuration surfaces and defaults differ. The same sentence, cache this HTML for an hour and purge it on deploy, can produce different keys, different purge coverage, and different content at the edge.",
  },
  {
    type: "p",
    text: "Cloudflare's default cache key includes the full URL with its query string, plus the Origin header and a set of forwarding and method-override headers. Custom cache keys can include or exclude query parameters, headers, cookies, host, and user features such as device type or language. Akamai's cache key includes the hostname and path by default, with query strings added by default but configurable through Cache ID Modification, which can also include headers, cookies, or variables. A rule that relies on the default key therefore starts from a different place on each provider.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, edge rules, cache lookup, origin. The rule order decides what the cache sees. A redirect or rewrite that runs before the cache lookup changes the key; a cache lookup that runs first uses the public URL. Akamai Property Manager evaluates rules top-down, so a redirect behavior earlier in the property can run before the cache behavior. Cloudflare evaluates Cache Rules and other rule types in defined phases; a redirect rule does not necessarily run in the same phase as the cache rule. The operational question is not which model is better; it is which key was stored and which purge instruction reaches it.",
  },
  {
    type: "compare",
    leftTitle: "Cloudflare",
    rightTitle: "Akamai",
    rows: [
      { label: "Default cache key", left: "Full URL including query string, plus Origin and selected forwarding headers", right: "Hostname and path, with query strings added by default; optional headers, cookies, and variables" },
      { label: "TTL control", left: "Cache Rules and origin cache headers", right: "Caching behavior in Property Manager; the default edge TTL is effectively infinite with LRU eviction" },
      { label: "Purge scope", left: "URL, tag, host, or prefix", right: "URL, ARL, CP code, or cache tag" },
      { label: "Rule order", left: "Rule types evaluate in defined phases", right: "Property rules evaluate top-down" },
    ],
  },
  {
    type: "p",
    text: "Purge is asynchronous on both. The API accepting a purge means the request was accepted, not that every edge has applied it. A tag or CP code purge can cover every variant of a changed object, while a URL purge covers exactly one URL. If the cache key includes a query string or a rewritten path, a URL purge can leave the other keys untouched. That is a scope mismatch, and it looks like a slow purge until you compare the key with the purge.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hit and miss rates, which reveal whether the key was translated with the same cardinality.",
      "Stale responses, which reveal a purge scope or rule-order mismatch.",
      "Origin requests, the cost of a fragmented key or a broad purge.",
      "Purge propagation time, shown separately because an accepted purge is not a completed one.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy on Cloudflare, then apply Akamai tag purge to see the same intent with a slower propagation path. Apply Ported rule to see the failure: a URL purge, full query key, and redirect before cache. Run the experiment, then apply the fix and compare stale responses, origin load, and purge lag. Switch the provider after each change to see which behavior is configuration and which is the platform.",
  },
  {
    type: "table",
    headers: ["Concept", "What to verify when porting"],
    rows: [
      ["Cache key", "Which query parameters, headers, and cookies are included by default; what the custom key actually includes"],
      ["TTL", "Whether the origin header, the rule, or the provider default wins; what the default is"],
      ["Purge scope", "Whether the scope covers every key variant, including rewrites and query strings"],
      ["Propagation", "How long until every region agrees; whether the API response means accepted or complete"],
      ["Rule order", "Whether a redirect or rewrite runs before the cache lookup and changes the stored key"],
    ],
  },
  {
    type: "p",
    text: "The first question is which behavior you depend on. A static asset with a hashed URL depends on the key and the TTL, not on purge. A mutable HTML page depends on the purge scope and rule order. A multi-tenant API depends on the key fields and the origin request policy. Porting the rule text is not enough; port the behavior and test it with requests that differ in the fields you care about.",
  },
  { type: "sim", simId: "edge-provider-behavior" },
  { type: "experiment", experimentId: "predict-portability" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset moved a working intent to Akamai but kept a URL purge, the provider default key with the full query string, and a redirect before the cache lookup. The key count rose to about 20,000, the hit rate fell to about 50%, and about half of responses could be stale: the URL purge covered one variant, and the redirect changed the key that was actually stored. The origin saw about 10,000 rps. None of the settings was obviously wrong in isolation; together they described a different system from the one that worked.",
  },
  {
    type: "p",
    text: "The fix was semantic, not a capacity change: normalize the key to the meaningful variants, purge by tag so every variant is covered, and put the cache lookup before the redirect. Stale responses fell below 2% and origin traffic returned to about 1,400 rps. A purge propagation warning remained because the Akamai profile is slower in this model. That warning is honest: portability does not mean identical timing, only identical intent with verified behavior.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache status by region and by URL, including `HIT`, `MISS`, `EXPIRED`, and `BYPASS`, sampled before and after the migration.",
      "The actual cache key for a set of representative requests: vary one query parameter, one header, and one cookie at a time.",
      "Purge status and time to the last region, not just the API response for the purge request.",
      "Origin request rate by path, which rises when the key is fragmented or the purge is too broad.",
      "Rule traces or logs that show whether a redirect or rewrite ran before the cache lookup.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Send two requests that differ only in the field you think is in the key. If they return different cache statuses, the key includes it; if they share a status, it does not. Then check whether the purge scope covers the key that was stored. Only after those two checks should you look at origin capacity or DNS.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the behavior you depend on: key fields, TTL source, purge scope, and rule order.",
      "Translate each behavior to the new provider's configuration surface, not just the rule name.",
      "Test the key with requests that vary one field at a time and compare cache status.",
      "Test the purge with a changed object and verify every region and every variant.",
      "Keep a rollback path to the old configuration until the new behavior is verified.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broader purge scope covers more variants and refetches more objects; a narrower scope is precise but can miss keys.",
      "A normalized key improves hit rate and can serve the wrong variant if a meaningful parameter is stripped.",
      "Putting the cache before the redirect protects the public URL but may cache a response the redirect rule intended to bypass.",
      "Provider-specific features can improve behavior, but they increase the translation work and the lock-in.",
      "Faster purge propagation is useful, but no provider guarantees an instantaneous global purge.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "port-config",
    question:
      "You are moving a cache rule from Cloudflare to Akamai. What do you inventory before the change, and how do you verify it?",
    difficulty: 3,
    hints: [
      "The rule name is not the behavior.",
      "Key, TTL, purge scope, and rule order are separate.",
    ],
    answer:
      "I would inventory the four behaviors separately: the cache key fields and their cardinality, the TTL source and precedence, the purge scope and propagation, and the rule order relative to redirects and rewrites. Then I would test each one on the new provider with requests that differ in a single field: a tracking query parameter, a language header, a cookie, and a rewritten path. I would compare cache status and key count, then purge a changed object and verify every region and variant. I would keep the old configuration available for rollback until the new one passes those checks.",
    followUps: [
      "Which behavior is most likely to differ silently?",
      "How would you test rule order?",
      "What would you do if the purge scope cannot cover every variant?",
    ],
    redFlags: [
      "Copies the rule text and assumes it behaves the same.",
      "Checks only one region.",
      "Ignores the key's query string behavior.",
    ],
    rubric: [
      "Separates key, TTL, purge, and rule order.",
      "Tests one field at a time.",
      "Checks multiple regions and variants.",
      "Keeps a rollback path.",
    ],
  },
  {
    id: "purge-scope",
    question:
      "A URL purge returns success, but some users still see the old page. How do you explain it?",
    difficulty: 3,
    hints: [
      "A URL purge covers one key.",
      "The cache key may include query strings or a rewritten path.",
    ],
    answer:
      "A successful purge request means the provider accepted the instruction, not that every edge has applied it. I would check the cache key first: if it includes query strings, headers, or a rewritten path, a URL purge covers only one variant. I would compare the public URL with the stored key, test each variant, and check the purge scope. If the key is the problem, I would purge by tag or change the object identity with a versioned URL. If the key matches but some regions are stale, I would check propagation and the time to the last region.",
    followUps: [
      "How would you prove the key mismatch?",
      "When would a tag purge be worse than a URL purge?",
      "What does a versioned URL change about the purge?",
    ],
    redFlags: [
      "Repeats the same URL purge.",
      "Assumes one region represents the world.",
      "Ignores the rewritten path.",
    ],
    rubric: [
      "Separates acceptance from completion.",
      "Checks the key and variants.",
      "Considers tag or versioned URL.",
      "Verifies multiple regions.",
    ],
  },
  {
    id: "rule-order",
    question:
      "Why can a redirect rule change what a cache purge reaches?",
    difficulty: 3,
    hints: [
      "The cache key is computed at a point in the request pipeline.",
      "A redirect can rewrite the URL before the cache sees it.",
    ],
    answer:
      "If the redirect or rewrite runs before the cache lookup, the cache may store an object under the rewritten URL or under a key derived from it. A purge by the public URL then targets a different key and leaves the stored object untouched. The order is part of the cache behavior, not an implementation detail. I would check where the cache rule sits relative to the redirect, trace one request through both rules, and compare the stored key with the purge URL. The fix is either to put the cache lookup before the redirect or to purge the rewritten key as well.",
    followUps: [
      "How would you trace the rule order in each provider?",
      "What would you cache if the redirect is intentional?",
      "How would you test this without waiting for a deploy?",
    ],
    redFlags: [
      "Assumes the public URL is always the cache key.",
      "Purges both URLs without understanding why.",
      "Ignores the redirect path.",
    ],
    rubric: [
      "Explains key derivation after rewrite.",
      "Locates the cache rule in the pipeline.",
      "Proposes a trace or test.",
      "Names a fix or a broader purge.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cache key fields and cardinality are documented for each provider.",
      "The TTL source and precedence are known: origin header, rule, or provider default.",
      "Purge scope and propagation are tested in every region.",
      "Rule order is traced for redirects and rewrites that affect cached keys.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare a request's cache status on the old and new providers.",
      "Vary one query parameter, header, or cookie at a time to find the key difference.",
      "Check whether a purge by public URL reaches the stored key.",
      "Check origin load and stale responses before adding capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a migration test that compares key count and purge coverage.",
      "Document provider-specific behavior that the application depends on.",
      "Keep a rollback path until the new configuration passes regional checks.",
      "Review whether versioned URLs can remove the purge dependency.",
    ],
  },
];

const references = [
  {
    title: "Cache keys",
    url: "https://developers.cloudflare.com/cache/how-to/cache-keys/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Default Cloudflare cache key fields, custom key settings, query strings, headers, cookies, and hit-rate impact.",
  },
  {
    title: "Learn about Akamai's caching",
    url: "https://techdocs.akamai.com/property-mgr/docs/know-caching",
    publisher: "Akamai",
    kind: "docs" as const,
    note: "Cache key elements, default TTL and LRU behavior, prefresh, purge, and redirect caching.",
  },
  {
    title: "Cache ID Modification",
    url: "https://techdocs.akamai.com/property-mgr/docs/cache-id-modification",
    publisher: "Akamai",
    kind: "docs" as const,
    note: "How Akamai adds or excludes query parameters, headers, cookies, and variables from the cache key.",
  },
  {
    title: "Invalidate and delete methods",
    url: "https://techdocs.akamai.com/purge-cache/docs/purge-methods",
    publisher: "Akamai",
    kind: "docs" as const,
    note: "Fast Purge by URL, ARL, CP code, or cache tag, and the invalidate-versus-delete distinction.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "edge-provider-behavior": {
      model: edgeProviderBehaviorModel,
      presets,
      instructions:
        "Start Healthy on Cloudflare, then apply Akamai tag purge to compare propagation. Apply Ported rule to see the stale-content failure. Run the experiment, then apply the fix and compare stale responses, origin load, and purge lag.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Purge propagation times, query-variant counts, and the rule-order penalty are teaching values, not provider guarantees. The cache-key and purge mechanics are documented; verify current defaults and limits before porting a configuration.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-cdn-ttl-purge",
    "traffic-cdn-cache-keys",
    "traffic-origin-shield",
    "foundations-cache-invalidation",
  ],
};
