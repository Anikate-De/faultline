import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CACHE_CAPACITY = 20_000;
const QUERY_VARIANTS = 40;
const MEANINGFUL_VARIANTS = 3;
const VISITORS = 25_000;
const MAX_HIT = 99.5;
const ORIGIN_CAPACITY = 8_000;
const WRONG_QUERY_SHARE = 22;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 60_000,
    step: 500,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second for cacheable objects. Every request still pays for a key lookup even when it misses.",
    format: "rps" as const,
  },
  {
    id: "objectCount",
    label: "Distinct object paths",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: "",
    group: "Working set",
    help: "Distinct paths in the working set, before query strings, cookies, or headers multiply the key space.",
    format: "count" as const,
  },
  {
    id: "queryPolicy",
    label: "Query-string policy (0 ignore, 1 full, 2 normalized)",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Cache key",
    help: "Zero drops the query string, which is fast but can serve the wrong variant. One keys every parameter, including tracking parameters. Two keeps meaningful variants and strips tracking parameters.",
    format: "count" as const,
  },
  {
    id: "cookieInKey",
    label: "Session cookie in key (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Cache key",
    help: "A per-session cookie has one value per visitor. Including it turns one object into one object per visitor.",
    format: "count" as const,
  },
  {
    id: "userHeaderInKey",
    label: "Per-user header in key (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Cache key",
    help: "A header such as X-User-Id is unique per user. It protects correctness only if the response truly differs per user, and it fragments the cache either way.",
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
  requestRate: number;
  objectCount: number;
  queryPolicy: number;
  cookieInKey: boolean;
  userHeaderInKey: boolean;
  queryKeys: number;
  identityKeys: number;
  keyCount: number;
  hitRate: number;
  originRps: number;
  originUtil: number;
  wrongContent: number;
  queryLabel: string;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const objectCount = Math.max(1, Math.round(num(p, "objectCount", 500)));
  const queryPolicy = Math.round(clamp(num(p, "queryPolicy", 2), 0, 2));
  const cookieInKey = num(p, "cookieInKey", 0) >= 0.5;
  const userHeaderInKey = num(p, "userHeaderInKey", 0) >= 0.5;
  const queryKeys =
    queryPolicy === 0 ? 1 : queryPolicy === 1 ? QUERY_VARIANTS : MEANINGFUL_VARIANTS;
  const identityKeys = cookieInKey || userHeaderInKey ? VISITORS : 1;
  const keyCount = objectCount * queryKeys * identityKeys;
  const hitRate = Math.min(MAX_HIT, (CACHE_CAPACITY / (CACHE_CAPACITY + keyCount)) * 100);
  const originRps = requestRate * (1 - hitRate / 100);
  const originUtil = (originRps / ORIGIN_CAPACITY) * 100;
  const wrongContent = queryPolicy === 0 ? (WRONG_QUERY_SHARE * hitRate) / 100 : 0;
  const queryLabel = queryPolicy === 0 ? "ignored" : queryPolicy === 1 ? "full" : "normalized";
  return {
    requestRate,
    objectCount,
    queryPolicy,
    cookieInKey,
    userHeaderInKey,
    queryKeys,
    identityKeys,
    keyCount,
    hitRate,
    originRps,
    originUtil,
    wrongContent,
    queryLabel,
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
  const hitHealth = d.hitRate >= 80 ? "ok" : d.hitRate >= 60 ? "warn" : "crit";
  const contentHealth = d.wrongContent >= 2 ? "crit" : d.wrongContent >= 0.5 ? "warn" : "ok";
  const edgeHealth = worst(hitHealth, contentHealth);
  const originHealth = healthFor(d.originUtil, 70, 90);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: d.requestRate,
        sublabel: `${formatCount(d.requestRate)} rps offered`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "CDN edge cache",
        kind: "cdn",
        health: edgeHealth,
        utilization: clamp(d.keyCount / 200_000),
        throughput: d.requestRate,
        sublabel: `${formatCount(d.keyCount)} keys · ${d.hitRate.toFixed(1)}% hit`,
        detail: `Query string ${d.queryLabel}. Cookie in key: ${d.cookieInKey ? "yes" : "no"}. Per-user header in key: ${d.userHeaderInKey ? "yes" : "no"}. Illustrative cache capacity is ${formatCount(CACHE_CAPACITY)} keys.`,
        meta: { view: "flow", keys: d.keyCount },
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
        detail: `Illustrative origin capacity is ${formatCount(ORIGIN_CAPACITY)} rps. The edge forwards ${(100 - d.hitRate).toFixed(1)}% of requests plus any request that cannot be shared.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", d.requestRate / 60_000, edgeHealth),
      edge("edge-origin", "edge", "origin", d.originRps / 60_000, originHealth),
    ],
    metrics: [
      metric("hit-rate", "Cache hit rate", d.hitRate, "%", undefined, undefined, "percent"),
      metric("miss-rate", "Cache miss rate", 100 - d.hitRate, "%", 20, 40, "percent"),
      metric("origin-rps", "Origin requests", d.originRps, " rps", 5_000, 7_500, "rps"),
      metric("key-count", "Distinct cache keys", d.keyCount, " keys", 30_000, 100_000, "count"),
      metric("wrong-content", "Wrong-content responses", d.wrongContent, "%", 0.5, 2, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      queryPolicy: d.queryPolicy,
      identity: d.cookieInKey || d.userHeaderInKey ? 1 : 0,
      keyCount: d.keyCount,
    },
    summary: `${d.hitRate.toFixed(1)}% hit rate over ${formatCount(d.keyCount)} keys; ${formatCount(d.originRps)} rps reaches the origin; ${d.wrongContent.toFixed(1)}% wrong-content responses.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.03 * Math.sin((index + (seed % 5)) / 2.4)) + Math.sin(index / 2) * amplitude),
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
      "The cache key contains values with too many distinct variations, so the same object is stored under many keys and each copy is requested too rarely to stay useful.",
    fix:
      "Remove user-specific headers and cookies from the key, exclude tracking query parameters, and normalize case and parameter order. Keep only the inputs that change the response body.",
    checkFirst: [
      "Compare key count with object count: a multiplier of thousands points to a per-user value in the key.",
      "Inspect the top cache keys and the headers or cookies that make them unique.",
      "Check whether the origin varies the response on each field before removing it from the key.",
    ],
  },
  {
    id: "origin-rps",
    metricId: "origin-rps",
    warn: 5_000,
    crit: 7_500,
    title: "Origin is absorbing the miss traffic",
    cause:
      "A fragmented key turns most requests into misses. The origin is healthy enough to answer, but the edge is no longer shielding it from the offered load.",
    fix:
      "Reduce key cardinality first, then raise the cacheable TTL if the content allows it. Add origin capacity only after the key is fixed; capacity hides the design error and raises cost.",
    checkFirst: [
      "Read the cache status code on edge logs and split hits from misses by path.",
      "Compare origin request rate with the request rate before the key change.",
      "Check whether the origin is returning cacheable responses at all.",
    ],
  },
  {
    id: "key-count",
    metricId: "key-count",
    warn: 30_000,
    crit: 100_000,
    title: "Cache key space is too large to reuse",
    cause:
      "Every extra key field multiplies the key space. A per-user header or cookie is the usual cause; a full query string with campaign parameters is the other.",
    fix:
      "Design the key from the response, not the request: include language, currency, or device class only if the origin returns a different body for each. Prefer URL-based variants that can be linked and cached independently.",
    checkFirst: [
      "List the cache-key fields and the cardinality of each value.",
      "Check query strings for marketing parameters and repeated parameters in different orders.",
      "Confirm whether `Vary` names a header that is actually needed.",
    ],
  },
  {
    id: "wrong-content",
    metricId: "wrong-content",
    warn: 0.5,
    crit: 2,
    title: "The cache is serving the wrong variant",
    cause:
      "The key omits an input that changes the response. Ignoring the query string is the common case when language, currency, or product options are encoded there.",
    fix:
      "Retain the meaningful query parameters in the key and strip only known tracking parameters. If the response is personalized, mark it private or bypass the shared cache instead of adding a per-user key.",
    checkFirst: [
      "Reproduce the wrong response with two requests that differ only in the omitted input.",
      "Check the origin's `Vary` header and the application's use of query parameters.",
      "Compare the cache key with the fields that actually change the response body.",
    ],
  },
];

export const cdnCacheKeysModel: SimModel = {
  id: "traffic-cdn-cache-keys",
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
    const originRps = d.requestRate * (1 - hitRate / 100);
    const next = buildFrame(d, seed);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      seed,
      paramsKey: key,
    };
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
          ? { ...item, value: 100 - hitRate }
          : item.id === "origin-rps"
            ? { ...item, value: originRps }
            : item,
    );
    const previousPolicy = Number(frame.flags.queryPolicy ?? d.queryPolicy);
    const previousIdentity = Number(frame.flags.identity ?? 0);
    if (d.queryPolicy !== previousPolicy) {
      pushEvent(next, {
        id: "query-policy-change",
        at: frame.t,
        severity: d.queryPolicy === 0 ? "warn" : "info",
        title:
          d.queryPolicy === 0
            ? "Query string removed from the cache key"
            : d.queryPolicy === 1
              ? "Full query string added to the cache key"
              : "Query string normalized in the cache key",
        detail:
          d.queryPolicy === 0
            ? "Requests that differ only by query string now share one object. Variants that depend on the query can be served the wrong response."
            : d.queryPolicy === 1
              ? `Every query variation becomes a separate key: about ${formatCount(d.objectCount * QUERY_VARIANTS)} keys before identity fields.`
              : `Tracking parameters are stripped and meaningful variants are retained: about ${formatCount(d.objectCount * MEANINGFUL_VARIANTS)} keys.`,
        nodeId: "edge",
        metricId: "key-count",
      });
    }
    if (d.cookieInKey || d.userHeaderInKey) {
      if (previousIdentity !== 1) {
        pushEvent(next, {
          id: "identity-key-enabled",
          at: frame.t,
          severity: "crit",
          title: "A per-user value entered the cache key",
          detail: `${d.cookieInKey ? "The session cookie" : "The per-user header"} is unique per visitor. The key space is now about ${formatCount(d.keyCount)} keys, so a shared object is unlikely to be reused.`,
          nodeId: "edge",
          metricId: "key-count",
        });
      }
    } else if (previousIdentity === 1) {
      pushEvent(next, {
        id: "identity-key-disabled",
        at: frame.t,
        severity: "info",
        title: "Per-user value removed from the cache key",
        detail: `The key space fell to about ${formatCount(d.keyCount)} keys. Confirm that no response still varies by the removed field.`,
        nodeId: "edge",
        metricId: "key-count",
      });
    }
    if (d.keyCount >= 100_000 && frame.flags.keyExplosion !== 1) {
      pushEvent(next, {
        id: "key-explosion",
        at: frame.t,
        severity: "crit",
        title: "Cache key space exceeded 100,000 entries",
        detail: `${formatCount(d.keyCount)} keys for ${formatCount(d.objectCount)} paths. At this size the working set no longer fits, so most objects leave the cache before they are requested again.`,
        nodeId: "edge",
        metricId: "key-count",
      });
      next.flags.keyExplosion = 1;
    }
    if (d.keyCount < 100_000) next.flags.keyExplosion = 0;
    if (d.originRps >= ORIGIN_CAPACITY && frame.flags.originOverload !== 1) {
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
    next.flags.queryPolicy = d.queryPolicy;
    next.flags.identity = d.cookieInKey || d.userHeaderInKey ? 1 : 0;
    next.flags.keyCount = d.keyCount;
    next.summary = `${hitRate.toFixed(1)}% hit rate over ${formatCount(d.keyCount)} keys; ${formatCount(originRps)} rps reaches the origin; ${d.wrongContent.toFixed(1)}% wrong-content responses.`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `${formatCount(d.objectCount)} paths become ${formatCount(d.keyCount)} keys after query and identity fields. The cache holds about ${formatCount(CACHE_CAPACITY)} keys in this model.`,
    );
    if (d.queryPolicy === 1) {
      items.push(
        `The full query string adds a key for every parameter combination, including marketing parameters that do not change the response.`,
      );
    }
    if (d.queryPolicy === 2) {
      items.push(
        `Normalization keeps about ${MEANINGFUL_VARIANTS} meaningful variants per path and strips the rest. That is the reuse gain.`,
      );
    }
    if (d.queryPolicy === 0) {
      items.push(
        `Ignoring the query avoids fragmentation, but up to about ${WRONG_QUERY_SHARE}% of requests in this model depend on a query parameter. A cached hit can return another variant.`,
      );
    }
    if (d.cookieInKey || d.userHeaderInKey) {
      items.push(
        `A per-user field multiplies the key space by ${formatCount(VISITORS)}. That is why hit rate falls even though the cache is working as configured.`,
      );
    }
    items.push(
      `${formatCount(d.originRps)} rps misses reach the origin. The edge is not overloaded; it is failing to reuse.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Fragmented", tone: "warn" },
    { label: "Origin overloaded", tone: "crit" },
    { label: "Wrong variant", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Normalized query keys, no identity fields, and a working set that fits the cache.",
    tone: "ok",
    params: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 2 }),
  },
  {
    id: "peak",
    label: "Full query string",
    description: "Every query variation becomes a key. Hit rate falls and the origin absorbs the misses.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, objectCount: 1_000, queryPolicy: 1 }),
  },
  {
    id: "failure",
    label: "Per-user header",
    description: "A per-user header in the key creates one copy per visitor; reuse collapses.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 2, userHeaderInKey: 1 }),
  },
  {
    id: "cookie-key",
    label: "Session cookie in key",
    description: "The session cookie fragments the cache to one object per visitor while protecting personalization.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 2, cookieInKey: 1 }),
  },
  {
    id: "query-blind",
    label: "Query ignored",
    description: "The key is small and the hit rate is high, but language and currency variants collide.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Normalized query keys with no identity fields; the origin falls back under capacity.",
    tone: "ok",
    params: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-user-header",
  title: "Predict what a per-user header does to the cache",
  simId: "cache-keys",
  question:
    "You add X-User-Id to the cache key so a personalized page can never be shared. The response is still cacheable. What happens to hit rate and origin load?",
  prediction: {
    options: [
      { id: "hit-falls", label: "Hit rate collapses and origin load rises, because each visitor gets a separate copy." },
      { id: "hit-rises", label: "Hit rate rises, because each user now gets a stable cached copy." },
      { id: "no-change", label: "Nothing changes; headers do not affect the cache key unless Vary is set." },
      { id: "origin-falls", label: "Origin load falls, because the personalized copies are smaller." },
    ],
    correctOptionId: "hit-falls",
    explanation:
      "A cache key must include every input that changes the response, but a per-user value has one distinct value per visitor. The cache still works; it simply stores one copy per user, so the reuse that made the cache valuable disappears. Correctness is preserved, but the origin now serves nearly every request. Personalized responses are usually better marked private or served from a personalization layer, not stored in a shared cache under a per-user key.",
  },
  setup: defaults({
    requestRate: 20_000,
    objectCount: 500,
    queryPolicy: 2,
    cookieInKey: 0,
    userHeaderInKey: 1,
  }),
  runFor: 20,
  observe: [
    "Distinct keys jump from about 1,500 to about 37.5 million.",
    "Hit rate falls to near zero and origin traffic approaches the full 20,000 rps.",
    "Wrong-content responses stay at zero: the key is correct, but the cache is no longer shared.",
    "Removing the header returns the hit rate without changing the query policy.",
  ],
  explain:
    "The cache key is an identifier, not a security boundary. Adding X-User-Id guarantees that two users cannot share an entry, but it also guarantees that no two users can share an entry. The same logic applies to a session cookie. If the response is truly personalized, the correct control is a private cache directive or an origin-side personalization step; if only a small fragment varies, split that fragment out and cache the rest.",
  fix: defaults({ requestRate: 20_000, objectCount: 500, queryPolicy: 2, userHeaderInKey: 0 }),
  debrief:
    "With the header removed the key returns to about 1,500 entries and the hit rate returns to the low 90s. The origin is protected again. The tradeoff is that the shared response must not contain user-specific data; if it does, fix the response boundary rather than the key. The next thing to verify is that the origin's Vary header names only fields that actually change the body.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cache key is the identifier a content delivery network (CDN) computes for a request before it looks in its cache. Two requests share a cached response only when they produce the same key and the stored response is still valid. The key usually contains the scheme, host, and path; it may also contain the query string, selected headers, cookies, or a device class. `Vary` is the origin's way of saying that a response depends on one or more request headers. Some CDNs honor `Vary` directly; others require the same fields in a cache policy. Either way, the key must include those values or the edge can serve one variant for another.",
  },
  {
    type: "p",
    text: "The design tension is cardinality. Every field in the key multiplies the number of distinct entries. Query strings carry both meaningful variants, such as language or currency, and irrelevant variants, such as campaign tracking parameters. Cookies and per-user headers are unique per visitor. A key that includes them is correct for personalized content, but it turns a shared cache into a per-user cache and removes most of the reuse. A key that omits a field that changes the response is smaller and faster, but it can serve the wrong content.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, CDN edge, origin. The edge computes the key, looks up the object, and either serves it or fetches it from the origin. The origin request can carry more fields than the cache key: CloudFront separates the cache key from the origin request policy, so a header can be forwarded to the origin for analytics or personalization without becoming part of the shared key. That separation is the main design lever. If the origin returns a different body for a field, the field belongs in the key or the response must not be shared.",
  },
  {
    type: "compare",
    leftTitle: "Small key",
    rightTitle: "Large key",
    rows: [
      { label: "Reuse", left: "High: many requests map to one entry", right: "Low: each variation gets its own entry" },
      { label: "Origin load", left: "Low until an omitted field causes a miss or a bypass", right: "High: more distinct objects mean more fills and revalidations" },
      { label: "Correctness", left: "At risk when the response varies on a field that is not in the key", right: "Protected for the fields included, but personalization may still leak through shared storage" },
      { label: "Typical fields", left: "Host, path, normalized query", right: "Full query, cookies, per-user headers, device class" },
    ],
  },
  {
    type: "p",
    text: "A useful test is to ask what the origin does with each field. If it only logs the field, forward it but do not key on it. If it changes the response body, either key on it or make the response uncacheable. If it changes only a small fragment, split the fragment into its own request and cache the shell. This is why the same path can have a high hit rate on one configuration and a much lower hit rate on another without any change in traffic.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cache hit rate and distinct key count, which move in opposite directions as fields are added.",
      "Origin requests per second, the direct cost of a fragmented key.",
      "Wrong-content responses, which rise when a meaningful query variant is dropped.",
      "The edge and origin node health, so a cache design problem is not mistaken for an origin capacity problem.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the key count. Apply Full query string and watch the key count grow while the hit rate falls. Apply Per-user header or Session cookie in key and watch the origin take nearly all traffic. Apply Query ignored to see the opposite failure: a high hit rate with wrong variants. Use the query policy to find the middle: normalized keys keep meaningful variants and drop tracking parameters.",
  },
  {
    type: "table",
    headers: ["Key field", "Include when", "Cost of including"],
    rows: [
      ["Host and path", "Always: they identify the object", "None beyond the object itself"],
      ["Query string", "The origin returns a different body for a parameter", "Every distinct value becomes a key; tracking parameters are pure fragmentation"],
      ["Cookie", "The response truly depends on that cookie and is safe to share", "Per-session values create one entry per visitor; personal data may be stored in a shared cache"],
      ["Per-user header", "Almost never for a shared cache", "One entry per user; hit rate collapses"],
      ["Accept-Language or device class", "The origin returns localized or device-specific content", "A small, bounded multiplier if values are normalized"],
      ["User-Agent", "Rarely: the value space is huge", "Thousands of variants for little reuse"],
    ],
  },
  {
    type: "p",
    text: "The first question is not which fields are available; it is which fields change the response. The second is whether the resulting variant should be shared at all. A cache key can be correct and still be a bad design if it destroys reuse or stores private data. The simulator separates those outcomes: hit rate and origin load show fragmentation, while wrong-content responses show an omitted variant.",
  },
  { type: "sim", simId: "cache-keys" },
  { type: "experiment", experimentId: "predict-user-header" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The default key used the path plus a normalized query string. About 500 paths became roughly 1,500 keys, the cache held them, and the hit rate stayed high. Adding the full query string multiplied the key space by the number of query variations and pushed the origin above its illustrative capacity. Adding a per-user header or session cookie multiplied it by the number of visitors and collapsed reuse almost completely. Ignoring the query did the opposite: the hit rate looked healthy, but requests that depended on a query parameter received another variant.",
  },
  {
    type: "p",
    text: "The important distinction is between a cache that is broken and a cache that is doing exactly what it was told. A per-user key is not a bug in the CDN; it is a design choice with a predictable cost. The edge still serves correct content, but the origin sees nearly every request. The fix is to change the key or the response boundary, not to add origin capacity and accept the cost.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CDN analytics: cache hit ratio, origin request rate, and bytes served from origin, split by path, status, and cache key.",
      "Edge logs: the cache status (`HIT`, `MISS`, `BYPASS`, `EXPIRED`) and the key fields used for the request. Sample before and after a key change.",
      "Key cardinality: the number of distinct keys per path. A per-user field shows up as a key count close to the visitor count.",
      "Origin logs: request rate and `Vary` headers. If the origin varies on a header that the edge does not key on, the edge may serve the wrong variant.",
      "Synthetic checks: request the same path with two different meaningful query values and compare the body. This catches an omitted variant without waiting for a customer report.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the key fields and their cardinality before touching origin capacity. If the hit rate fell after a configuration change, compare the key template before and after. If the hit rate is high but users report the wrong content, compare the key with the origin's Vary header and the query parameters that change the body.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the fields in the cache key and the number of distinct values each one can take.",
      "Remove fields that do not change the response body; forward them to the origin if analytics needs them.",
      "Normalize query strings: strip known tracking parameters, sort the remaining parameters, and keep language, currency, and format variants.",
      "For personalized responses, use a private cache directive or split the personalized fragment instead of keying on a user identifier.",
      "Warm the cache after the change and compare hit rate, key count, origin rate, and wrong-content checks before declaring success.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A smaller key improves hit rate and lowers origin cost, but it increases the risk of serving a variant that the origin would have returned differently.",
      "A per-user key protects correctness for personalized content, but it destroys shared-cache economics and may store private data at the edge.",
      "Query normalization reduces fragmentation, but the normalization rules must be maintained as the application adds parameters.",
      "Splitting personalized fragments adds a request and a cache key of its own; the shell can be shared, but the fragment still needs a correct policy.",
      "Longer TTLs improve hit rate but widen the window for stale content; key design and freshness policy have to be tuned together.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-key-fragmentation",
    question:
      "A CDN reports a 30% hit rate and the origin is at 90% CPU. The traffic volume has not changed. How do you find out whether the cache key is the problem?",
    difficulty: 2,
    hints: [
      "Compare key count with object count.",
      "Look for a field with one value per user.",
    ],
    answer:
      "I would start with key cardinality, not origin CPU. If the number of distinct cache keys is close to the number of visitors or sessions, a per-user field is in the key. I would inspect the key template and the `Vary` header, then sample edge logs for cache status and the key fields. A full query string with campaign parameters or a session cookie produces exactly this shape: the cache still works, but each entry is requested too rarely to be reused. I would compare the hit rate by path and by query parameter to see whether the fragmentation is broad or concentrated. Then I would remove fields that do not change the response, normalize the query string, and re-measure origin rate and wrong-content checks.",
    followUps: [
      "How would you prove that a field is safe to remove from the key?",
      "What would you check if the hit rate is high but users see the wrong currency?",
      "When is a per-user cache key the right choice?",
    ],
    redFlags: [
      "Starts by adding origin capacity.",
      "Assumes a high hit rate means the cache is correct.",
      "Removes fields without checking whether the response varies on them.",
    ],
    rubric: [
      "Checks key cardinality and key fields first.",
      "Distinguishes fragmentation from origin capacity.",
      "Names a safe removal or normalization step.",
      "Includes a correctness check after the change.",
    ],
  },
  {
    id: "vary-and-key",
    question:
      "The origin sends `Vary: Accept-Language, User-Agent`. What should the CDN key on, and what would you change at the origin?",
    difficulty: 2,
    hints: [
      "`Vary` describes response variation, not a recommendation to key on every value.",
      "User-Agent has a very large value space.",
    ],
    answer:
      "`Vary` tells the cache that the response depends on those request headers, so omitting them can serve the wrong variant. `Accept-Language` is usually a bounded set and can be normalized to a language code in the key. `User-Agent` is a poor key field because it has thousands of variants and often changes for reasons that do not affect the body. I would change the origin to vary on a normalized device class or a dedicated client-hint header, and make the CDN key on that bounded value. If the origin truly returns a different body per User-Agent string, the response is effectively uncacheable at shared scale; the better fix is to make the variation explicit in the URL or a small set of headers.",
    followUps: [
      "How would you verify that the normalized language key matches the origin's behavior?",
      "What happens to cached entries when you change `Vary`?",
      "How do client hints change this design?",
    ],
    redFlags: [
      "Keys on the full User-Agent because `Vary` names it.",
      "Ignores `Vary` entirely.",
      "Normalizes language without checking the origin's fallback behavior.",
    ],
    rubric: [
      "Explains `Vary` as response variation.",
      "Separates bounded from unbounded fields.",
      "Proposes a normalized key or URL variant.",
      "Checks correctness after the change.",
    ],
  },
  {
    id: "design-key",
    question:
      "Design a cache key for a product page that supports three currencies, two languages, and marketing campaign links. What belongs in the key, and what would you forward to the origin?",
    difficulty: 3,
    hints: [
      "Campaign parameters rarely change the body.",
      "Currency and language do change the body.",
    ],
    answer:
      "I would key on the path plus normalized language and currency, because those change the response body. I would strip marketing parameters such as campaign source and click identifiers, or forward them to the origin for analytics without including them in the key. If the page contains a personalized recommendation fragment, I would split that fragment into its own request and keep the product shell shared. I would verify the key against the origin's `Vary` header, test one URL per language and currency, and watch key count, hit rate, origin rate, and wrong-content checks after rollout. The key should be small enough to reuse and complete enough to be correct.",
    followUps: [
      "What would you do with a currency cookie instead of a query parameter?",
      "How would you migrate existing cache entries after the key change?",
      "What is the failure mode if the origin ignores the currency parameter?",
    ],
    redFlags: [
      "Includes every query parameter.",
      "Includes the session cookie.",
      "Forgets a correctness check.",
    ],
    rubric: [
      "Keys on bounded response-variant fields.",
      "Strips or forwards marketing parameters.",
      "Splits personalization instead of keying on the user.",
      "Names a verification plan.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cache key template is documented with the cardinality of each field.",
      "The origin's `Vary` header is reviewed against the key; no vary-worthy field is missing.",
      "Marketing and tracking query parameters are stripped or forwarded but not keyed.",
      "Cache hit rate, origin request rate, key count, and wrong-content checks are on one dashboard.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare key count with visitor or session count before adding origin capacity.",
      "Sample edge logs for cache status and key fields on the affected paths.",
      "Remove per-user fields and normalize query strings, then verify a known variant.",
      "Watch origin rate, hit rate, and wrong-content checks together after each change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a synthetic check that requests two meaningful variants and compares the body.",
      "Record the key change and the cache warm-up window.",
      "Review whether personalized responses should bypass the shared cache instead.",
      "Recheck key cardinality after the next product change.",
    ],
  },
];

const references = [
  {
    title: "Cache keys",
    url: "https://developers.cloudflare.com/cache/how-to/cache-keys/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Default cache key fields, custom cache keys, query string, headers, cookies, and the hit-rate tradeoff.",
  },
  {
    title: "Understand the cache key",
    url: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-the-cache-key.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default CloudFront cache key, cache policies, and why including values that do not affect the response creates duplicate objects.",
  },
  {
    title: "Default cache behavior",
    url: "https://developers.cloudflare.com/cache/concepts/default-cache-behavior/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Cache eligibility, cache lock, and the default behavior that a custom key changes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cache-keys": {
      model: cdnCacheKeysModel,
      presets,
      instructions:
        "Start Healthy, then apply Full query string. Watch distinct keys and origin requests. Apply Per-user header or Session cookie in key to see fragmentation. Apply Query ignored to see the correctness failure, then return to normalized keys.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Cache capacity, query variation, visitor count, origin capacity, and wrong-content share are teaching values, not provider guarantees. Real CDN behavior depends on the configured cache policy and origin response headers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-caching-strategies",
    "traffic-cdn-ttl-purge",
    "traffic-origin-shield",
    "caching-cache-stampede",
  ],
};
