import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const OBJECT_COUNT = 200_000;
const ORIGIN_CAPACITY = 8_000;
const PURGE_PROPAGATION_SECONDS = 90;
const MAX_HIT = 99.5;

const params = [
  {
    id: "ttlSeconds",
    label: "Cache TTL",
    min: 60,
    max: 86_400,
    step: 60,
    value: 3_600,
    unit: " s",
    group: "Freshness",
    help: "How long an edge may serve a cached object without checking the origin. Longer TTLs raise hit rate and widen the window for stale content.",
    format: "number" as const,
  },
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 50_000,
    step: 500,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second for the deployed objects. The stale count is this rate multiplied by the stale share.",
    format: "rps" as const,
  },
  {
    id: "deploysPerHour",
    label: "Deploys per hour",
    min: 1,
    max: 12,
    step: 1,
    value: 1,
    unit: "/h",
    group: "Release",
    help: "How often the asset set changes. A deploy every 15 minutes leaves less time for a purge to propagate than a deploy once an hour.",
    format: "count" as const,
  },
  {
    id: "releaseMode",
    label: "Release mode (0 overwrite, 1 overwrite + purge, 2 versioned)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Release",
    help: "Zero replaces the object in place and waits for TTL. One replaces it and purges the old path. Two publishes a new URL, so the old object is never requested again.",
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
  ttl: number;
  requestRate: number;
  deploysPerHour: number;
  releaseMode: number;
  deployInterval: number;
  purgeLag: number;
  staleRate: number;
  staleRequests: number;
  refreshRps: number;
  purgeRefreshRps: number;
  originRps: number;
  originUtil: number;
  hitRate: number;
  missRate: number;
  modeLabel: string;
}

function compute(p: Params): Computed {
  const ttl = Math.max(1, num(p, "ttlSeconds", 3_600));
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const deploysPerHour = Math.max(1, Math.round(num(p, "deploysPerHour", 1)));
  const releaseMode = Math.round(clamp(num(p, "releaseMode", 1), 0, 2));
  const deployInterval = 3_600 / deploysPerHour;
  const purgeLag = releaseMode === 1 ? Math.min(PURGE_PROPAGATION_SECONDS, deployInterval) : 0;
  const staleRate =
    releaseMode === 2
      ? 0
      : releaseMode === 1
        ? (purgeLag / deployInterval) * 100
        : Math.min(100, (ttl / deployInterval) * 100);
  const staleRequests = requestRate * (staleRate / 100);
  const refreshRps = Math.min(requestRate, OBJECT_COUNT / ttl);
  const purgeRefreshRps =
    releaseMode === 1 ? Math.min(requestRate, OBJECT_COUNT / deployInterval) : 0;
  const originRps = Math.min(requestRate, refreshRps + purgeRefreshRps);
  const originUtil = (originRps / ORIGIN_CAPACITY) * 100;
  const hitRate = Math.min(MAX_HIT, 100 * (1 - originRps / requestRate));
  const missRate = 100 - hitRate;
  const modeLabel =
    releaseMode === 0 ? "overwrite, no purge" : releaseMode === 1 ? "overwrite + purge" : "versioned URLs";
  return {
    ttl,
    requestRate,
    deploysPerHour,
    releaseMode,
    deployInterval,
    purgeLag,
    staleRate,
    staleRequests,
    refreshRps,
    purgeRefreshRps,
    originRps,
    originUtil,
    hitRate,
    missRate,
    modeLabel,
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
  const originHealth = healthFor(d.originUtil, 70, 90);
  const edgeHealth = d.staleRate >= 8 ? "crit" : d.staleRate >= 3 ? "warn" : "ok";
  const purgeMetric =
    d.releaseMode === 1
      ? metric("purge-lag", "Purge propagation", d.purgeLag, " s", undefined, undefined, "number")
      : null;
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
        utilization: clamp(d.staleRate / 100),
        throughput: d.requestRate,
        sublabel: `${d.hitRate.toFixed(1)}% hit · TTL ${formatCount(d.ttl)}s`,
        detail: `${d.modeLabel}. ${d.releaseMode === 1 ? `Purge propagation is about ${formatCount(d.purgeLag)}s in this model.` : "No purge is configured for this release mode."} ${d.staleRate.toFixed(1)}% of requests are served stale.`,
        meta: { view: "flow", staleRate: d.staleRate },
      },
      {
        id: "origin",
        label: "Origin",
        kind: "service",
        health: originHealth,
        utilization: clamp(d.originUtil / 100),
        throughput: d.originRps,
        capacity: ORIGIN_CAPACITY,
        sublabel: `${formatCount(d.originRps)} rps refreshes`,
        detail: `Illustrative origin capacity is ${formatCount(ORIGIN_CAPACITY)} rps. TTL refreshes add ${formatCount(d.refreshRps)} rps and purge refetches add ${formatCount(d.purgeRefreshRps)} rps.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", d.requestRate / 50_000, edgeHealth),
      edge("edge-origin", "edge", "origin", d.originRps / 50_000, originHealth),
    ],
    metrics: [
      metric("stale-rate", "Stale responses", d.staleRate, "%", 3, 8, "percent"),
      metric("stale-requests", "Stale requests", d.staleRequests, " rps", 800, 2_500, "rps"),
      metric("origin-rps", "Origin requests", d.originRps, " rps", 4_000, 6_000, "rps"),
      metric("miss-rate", "Cache miss rate", d.missRate, "%", 20, 40, "percent"),
      metric("hit-rate", "Cache hit rate", d.hitRate, "%", undefined, undefined, "percent"),
      ...(purgeMetric ? [purgeMetric] : []),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      releaseMode: d.releaseMode,
      ttl: d.ttl,
      staleRate: d.staleRate,
    },
    summary: `${d.hitRate.toFixed(1)}% hit rate with a ${formatCount(d.ttl)}s TTL; ${d.staleRate.toFixed(1)}% stale responses; ${formatCount(d.originRps)} rps reaches the origin (${d.originUtil.toFixed(0)}% of illustrative capacity).`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.04 * Math.sin((index + (seed % 6)) / 2.2)) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-rate",
    metricId: "stale-rate",
    warn: 3,
    crit: 8,
    title: "Deploys are serving stale assets",
    cause:
      "The TTL is longer than the deploy interval, and the old object is still fresh at the edge. A purge may not have run, may cover only one URL, or may still be propagating to some edge locations.",
    fix:
      "Publish immutable assets under a new URL and reference that URL from the entry document. For files that must keep their URL, purge by tag or path and verify propagation before announcing the deploy.",
    checkFirst: [
      "Compare the deploy timestamp with the cache `Age` and `Cache-Control` headers on the affected paths.",
      "Check the purge scope: a URL purge does not cover query variants or rewritten cache keys.",
      "Sample several edge locations, not one, because a purge reaches each cache independently.",
    ],
  },
  {
    id: "stale-requests",
    metricId: "stale-requests",
    warn: 800,
    crit: 2_500,
    title: "Stale traffic is large enough to affect users",
    cause:
      "The stale share is multiplied by a high request rate. Even a short propagation window produces many stale responses when the object is popular.",
    fix:
      "Reduce the stale window with versioned URLs, or lower the TTL for the entry document while keeping long TTLs for hashed assets. Purge before the deploy window and monitor the stale count by path.",
    checkFirst: [
      "Split stale responses by path and by asset type.",
      "Check whether the affected paths are HTML entry points or hashed static assets.",
      "Compare the request rate with the deploy frequency; a hot object makes every minute of propagation expensive.",
    ],
  },
  {
    id: "origin-rps",
    metricId: "origin-rps",
    warn: 4_000,
    crit: 6_000,
    title: "Short TTLs or broad purges are overloading the origin",
    cause:
      "Every TTL expiry can trigger a revalidation or refetch. A short TTL over a large object set, or a purge that invalidates everything, turns cache maintenance into origin traffic.",
    fix:
      "Use long TTLs for immutable, content-addressed assets and reserve short TTLs for the small set of mutable entry points. Purge by tag instead of purging the whole host, and prewarm critical objects after a deploy.",
    checkFirst: [
      "Compare origin request rate with the TTL and the number of objects.",
      "Check whether the purge invalidated the whole distribution or only changed paths.",
      "Look for a revalidation storm immediately after a deploy.",
    ],
  },
  {
    id: "miss-rate",
    metricId: "miss-rate",
    warn: 20,
    crit: 40,
    title: "Cache miss rate crossed the limit",
    cause:
      "The edge is revalidating or refetching too often. A TTL shorter than the request interval, a purge that keeps firing, or an object set that does not fit can all produce this pattern.",
    fix:
      "Lengthen the TTL where freshness allows, separate mutable HTML from immutable assets, and stop purging objects that did not change.",
    checkFirst: [
      "Check the TTL and the cache status codes by path.",
      "Check whether a deploy or purge coincides with the miss increase.",
      "Verify that the origin returns cacheable responses and a useful `ETag` or `Last-Modified`.",
    ],
  },
];

export const cdnTtlPurgeModel: SimModel = {
  id: "traffic-cdn-ttl-purge",
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
          : item,
    );
    const previousMode = Number(frame.flags.releaseMode ?? d.releaseMode);
    if (d.releaseMode !== previousMode) {
      pushEvent(next, {
        id: "release-mode-change",
        at: frame.t,
        severity: d.releaseMode === 0 ? "warn" : d.releaseMode === 2 ? "info" : "info",
        title:
          d.releaseMode === 0
            ? "Release mode changed to overwrite without purge"
            : d.releaseMode === 1
              ? "Release mode changed to overwrite with purge"
              : "Release mode changed to versioned URLs",
        detail:
          d.releaseMode === 0
            ? `The old object stays cached until its ${formatCount(d.ttl)}s TTL expires. Deploys are not visible immediately.`
            : d.releaseMode === 1
              ? `Each deploy invalidates the old path. Purge propagation is about ${formatCount(d.purgeLag)}s in this model, so a short stale window remains.`
              : "Each deploy publishes a new URL. The old object remains cached but is no longer requested, so no purge is needed for the asset itself.",
        nodeId: "edge",
        metricId: "stale-rate",
      });
    }
    if (d.staleRate >= 8 && frame.flags.staleDeploy !== 1) {
      pushEvent(next, {
        id: "stale-deploy",
        at: frame.t,
        severity: "crit",
        title: "A deploy left stale assets in the cache",
        detail: `${d.staleRate.toFixed(0)}% of requests are being served stale. The TTL is ${formatCount(d.ttl)}s and the deploy interval is ${formatCount(d.deployInterval)}s.`,
        nodeId: "edge",
        metricId: "stale-rate",
      });
      next.flags.staleDeploy = 1;
    }
    if (d.staleRate < 8) next.flags.staleDeploy = 0;
    if (d.originRps >= ORIGIN_CAPACITY && frame.flags.originOverload !== 1) {
      pushEvent(next, {
        id: "origin-overload",
        at: frame.t,
        severity: "crit",
        title: "Origin refetch rate reached the illustrative capacity",
        detail: `${formatCount(d.originRps)} rps is reaching the origin against an illustrative capacity of ${formatCount(ORIGIN_CAPACITY)} rps.`,
        nodeId: "origin",
        metricId: "origin-rps",
      });
      next.flags.originOverload = 1;
    }
    if (d.originRps < ORIGIN_CAPACITY) next.flags.originOverload = 0;
    next.flags.releaseMode = d.releaseMode;
    next.flags.ttl = d.ttl;
    next.flags.staleRate = d.staleRate;
    next.summary = `${hitRate.toFixed(1)}% hit rate with a ${formatCount(d.ttl)}s TTL; ${d.staleRate.toFixed(1)}% stale responses; ${formatCount(d.originRps)} rps reaches the origin (${d.originUtil.toFixed(0)}% of illustrative capacity).`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `A ${formatCount(d.ttl)}s TTL with a deploy every ${formatCount(d.deployInterval)}s means the old object can stay fresh for the whole interval. The stale share is ${d.staleRate.toFixed(1)}%.`,
    );
    if (d.releaseMode === 0) {
      items.push(
        "Without a purge, the only freshness bound is the TTL. A long TTL is excellent for hit rate and unacceptable for a release that users must see immediately.",
      );
    }
    if (d.releaseMode === 1) {
      items.push(
        `The purge is asynchronous. About ${formatCount(d.purgeLag)}s of propagation remains in this model, so a purge is not the same as an atomic switch.`,
      );
    }
    if (d.releaseMode === 2) {
      items.push(
        "Versioned URLs remove the asset from the purge path entirely: the deploy changes the key. The entry document that references the new URL still needs its own freshness policy.",
      );
    }
    items.push(
      `The origin sees ${formatCount(d.originRps)} rps from TTL refreshes and purge refetches. Short TTLs move freshness cost to the origin.`,
    );
    if (d.staleRequests > 0) {
      items.push(
        `${formatCount(d.staleRequests)} rps is served stale. The count matters more than the percentage when the object is hot.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Fresh", tone: "ok" },
    { label: "Stale window", tone: "warn" },
    { label: "Stale content", tone: "crit" },
    { label: "Origin pressure", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "One-hour TTL, one deploy per hour, purge on release. A short stale window remains.",
    tone: "ok",
    params: defaults({ ttlSeconds: 3_600, requestRate: 20_000, deploysPerHour: 1, releaseMode: 1 }),
  },
  {
    id: "peak",
    label: "Frequent deploys",
    description: "A five-minute TTL and a deploy every 30 minutes; the stale window grows and stale requests warn.",
    tone: "warn",
    params: defaults({ ttlSeconds: 300, requestRate: 20_000, deploysPerHour: 2, releaseMode: 1 }),
  },
  {
    id: "failure",
    label: "Long TTL, no purge",
    description: "A one-day TTL with deploys every 15 minutes and no purge. Every request can see stale content.",
    tone: "crit",
    params: defaults({ ttlSeconds: 86_400, requestRate: 20_000, deploysPerHour: 4, releaseMode: 0 }),
  },
  {
    id: "short-ttl",
    label: "Short TTL",
    description: "A one-minute TTL without purge keeps content fresher but sends a large refresh load to the origin.",
    tone: "warn",
    params: defaults({ ttlSeconds: 60, requestRate: 20_000, deploysPerHour: 4, releaseMode: 0 }),
  },
  {
    id: "recovery",
    label: "Versioned release",
    description: "Immutable assets under new URLs; no stale asset requests and a modest origin refresh rate.",
    tone: "ok",
    params: defaults({ ttlSeconds: 600, requestRate: 20_000, deploysPerHour: 2, releaseMode: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-versioned-release",
  title: "Predict how to make a deploy visible without a global purge",
  simId: "ttl-purge",
  question:
    "The assets have a one-day TTL and deploys happen four times an hour. A product change must be visible immediately on every edge. Which release strategy removes the stale-asset problem without purging the whole distribution?",
  prediction: {
    options: [
      { id: "versioned", label: "Publish each asset under a new content-addressed URL and update the entry document." },
      { id: "purge-all", label: "Purge the whole host after every deploy." },
      { id: "short-ttl", label: "Set every asset TTL to 60 seconds." },
      { id: "origin", label: "Add origin capacity so refetches are cheap." },
    ],
    correctOptionId: "versioned",
    explanation:
      "A new URL is a new cache key, so the old object is never requested again. No purge has to reach every edge, and the long TTL can stay for the old object. Purging the whole host makes every edge refetch everything and creates an origin spike. A 60-second TTL on every asset raises origin traffic continuously, and more origin capacity does not make stale content fresh.",
  },
  setup: defaults({ ttlSeconds: 86_400, requestRate: 20_000, deploysPerHour: 4, releaseMode: 0 }),
  runFor: 20,
  observe: [
    "One hundred percent of responses are stale at the start because the deploy interval is far shorter than the TTL.",
    "The hit rate is excellent and the origin is nearly idle: the cache is doing its job, just not the one the release needs.",
    "Stale requests reach the full 20,000 rps, so every user can receive the old object.",
    "Switching to versioned URLs drops stale responses to zero while the old object remains cached under its old URL.",
  ],
  explain:
    "A purge and a versioned URL solve different problems. A purge tries to remove an existing key from every cache; it is asynchronous, scoped, and easy to under- or over-apply. A versioned URL never asks the old key to change. The deploy writes a new object, the entry document points at it, and the long TTL on the old object becomes harmless. The cost moves to build and storage: you keep multiple versions and must update every reference to the asset.",
  fix: defaults({ ttlSeconds: 86_400, requestRate: 20_000, deploysPerHour: 4, releaseMode: 2 }),
  debrief:
    "Versioned URLs take stale asset responses to zero without a purge. The origin refresh rate falls to the normal TTL rate, and the old object expires on its own schedule. The entry document still needs a freshness policy because it is the thing that points at the new hashed URL; a short TTL or a small, targeted purge for HTML is the usual pairing. The tradeoff is version churn: build output, storage, and every reference must agree on the new name.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Time to live (TTL) is the freshness lifetime of a cached object. While the object is younger than its TTL, an edge can serve it without asking the origin. When the TTL expires, the edge revalidates with a conditional request or fetches a new copy. A longer TTL raises the chance that a request is served from the edge, but it also raises the chance that the object is older than the last deploy. A shorter TTL improves freshness and moves the cost to the origin.",
  },
  {
    type: "p",
    text: "A purge, also called an invalidation, is an explicit instruction to remove or mark stale an object before its TTL expires. Purges are scoped: a URL, a path, a tag, a host, or a content provider code, depending on the provider. They are also asynchronous. The API accepting a purge does not mean every edge has applied it; each location has its own cache and its own propagation path. A global purge can be the fastest way to make a change visible and the fastest way to send every edge to the origin at once.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The release path is build, upload, optionally purge, then edge caches. The request path is client, edge, origin. The edge decides whether its copy is fresh; the origin supplies a new copy when it is not. A purge inserts an instruction into that loop. If the object is content-addressed, the release path changes the URL and the edge sees a new key; no purge is required for the asset. The HTML or JSON document that references the asset still has its own TTL and may need a targeted purge or a short TTL.",
  },
  {
    type: "compare",
    leftTitle: "Overwrite in place",
    rightTitle: "Versioned URL",
    rows: [
      { label: "Freshness after deploy", left: "Bounded by TTL or by purge propagation", right: "Immediate: the new URL was never cached" },
      { label: "Purge required", left: "Yes, unless the TTL is short", right: "No for the asset; the entry document may still need one" },
      { label: "Origin cost", left: "Purge refetches the same key across edges", right: "One new object; old objects age out" },
      { label: "Operational risk", left: "Scope and propagation can leave stale copies", right: "Reference churn, storage, and cache retention" },
    ],
  },
  {
    type: "p",
    text: "TTL and purge are not alternatives to correctness. A purge that targets the public URL can miss the key that was actually cached after a rewrite. A TTL that is shorter than the deploy interval can still serve stale content during the window between the deploy and the next expiry. The release strategy has to make the object's identity change at the same time as its content, or accept a bounded stale window and measure it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stale response share and the absolute stale request rate, which show whether the problem is a small window or a popular object.",
      "Origin request rate from TTL refreshes and purge refetches, the cost of freshness.",
      "Cache hit and miss rates, which move with TTL and purge breadth.",
      "Purge propagation time, shown as a separate metric because API acceptance is not global completion.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Long TTL, no purge. Watch stale responses go to 100% while the hit rate stays high. Apply Short TTL to see the opposite cost: freshness improves and the origin takes the refresh load. Apply Versioned release and compare stale responses and origin rate. When a purge is configured, check its propagation metric before assuming the purge is complete.",
  },
  {
    type: "table",
    headers: ["Strategy", "Freshness", "Origin cost", "Main risk"],
    rows: [
      ["Long TTL, no purge", "Worst: stale until expiry", "Lowest", "Users see old assets after a deploy"],
      ["Long TTL, purge by URL", "Good if the purge covers the key", "Refetch of the purged paths", "Query variants or rewritten keys are missed"],
      ["Long TTL, purge by tag", "Good if every variant is tagged", "Refetch of all tagged objects", "A broad tag can invalidate more than intended"],
      ["Short TTL", "Bounded by the TTL", "Continuous revalidation", "Origin load and lower hit rate"],
      ["Versioned URL", "Immediate for the asset", "One new object per release", "Reference updates and old-version retention"],
    ],
  },
  {
    type: "p",
    text: "The first question is what must be fresh: the asset, the document that references it, or both. The second is whether the object can change its URL. If it can, versioning removes the purge from the critical path. If it cannot, the TTL and the purge scope have to be designed together, and the stale window has to be measured in requests, not just minutes.",
  },
  { type: "sim", simId: "ttl-purge" },
  { type: "experiment", experimentId: "predict-versioned-release" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset used a one-day TTL, four deploys an hour, and no purge. Every object stayed fresh by TTL while its content was already old, so the hit rate looked excellent and every response could be stale. The short-TTL preset fixed the stale window but sent a continuous refresh load to the origin. The purge preset reduced the stale window to the propagation time, but it did not make the switch atomic. The versioned preset removed the stale asset problem entirely by changing the cache key.",
  },
  {
    type: "p",
    text: "The cache was never broken in the failure preset. It was doing exactly what a long TTL tells it to do. The release process assumed that uploading a new object changes what the edge serves, but the edge serves by key and freshness, not by upload time. That distinction is the whole lesson: a deploy changes the origin, a TTL changes when the edge looks, and a purge tries to close the gap between them.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CDN logs: cache status (`HIT`, `MISS`, `EXPIRED`, `REVALIDATED`), `Age`, and the object's `Cache-Control` headers, split by path and edge location.",
      "Origin logs: conditional requests (`If-Modified-Since`, `If-None-Match`), 304 rate, and refetch rate after a deploy.",
      "Purge API results: request acceptance, purge ID, scope, and completion status. A 200 response is not proof that every edge has applied the purge.",
      "Synthetic checks from multiple regions: request the entry document and the asset, compare the version marker, and record the time until all regions agree.",
      "Deploy metadata: the commit, asset hashes, and the time the entry document began referencing the new URLs.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the object's `Age` and `Cache-Control` headers before purging again. Confirm the purge scope matches the cache key, including query variants and rewrites. If only some regions are stale, the purge is still propagating or the key differs by region; do not assume a second global purge will be cheaper than the first.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify whether the stale object is an asset, an entry document, or both.",
      "For immutable assets, publish a content-addressed URL and update the entry document.",
      "For mutable documents, set a TTL that matches the acceptable stale window and purge by the narrowest scope that covers every variant.",
      "Verify the purge against the actual cache key, including query normalization and rule rewrites.",
      "Measure stale requests by region and path until propagation completes, then remove the old version on a retention schedule.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Long TTLs lower origin cost and raise the stale window; short TTLs do the reverse.",
      "Purge by URL is precise but misses variants and rewritten keys; purge by tag is broader and can create a larger origin spike.",
      "Versioned URLs make releases atomic for the asset, but they add build output, storage, and reference updates.",
      "A global purge is simple to operate and expensive to absorb; it is a blunt instrument for a single changed file.",
      "Conditional revalidation can keep a stale object if the origin returns 304, so freshness depends on the origin's validators as well as the TTL.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-stale-deploy",
    question:
      "A deploy finished 20 minutes ago, but users in two regions still see the old JavaScript bundle. The CDN says the purge succeeded. How do you debug it?",
    difficulty: 2,
    hints: [
      "A purge response is not a global completion signal.",
      "Check the key, not just the URL.",
    ],
    answer:
      "I would check the cache key and the purge scope first. The purge may have targeted a URL that differs from the cached key because of a query string, a rewrite rule, or a host variant. I would compare `Age`, `Cache-Control`, and the cache status in each region, then request the asset directly from an edge in each region. If the purge is still propagating, some regions will show an old `Age` and a hit. I would also check whether the HTML entry point still references the old bundle. If the asset is immutable, the durable fix is a content-addressed URL; if it must keep its URL, purge by tag and verify with regional synthetic checks before announcing the release.",
    followUps: [
      "How would you prove that the purge key and the cache key match?",
      "What would you do if only one region is stale?",
      "How would you design the check that catches this before users do?",
    ],
    redFlags: [
      "Purges again without checking the key.",
      "Assumes a 200 from the purge API means every edge is updated.",
      "Blaming the origin without checking edge `Age`.",
    ],
    rubric: [
      "Checks the cache key and purge scope.",
      "Uses regional evidence, not one sample.",
      "Separates the asset from the entry document.",
      "Names a durable versioning fix.",
    ],
  },
  {
    id: "ttl-tradeoff",
    question:
      "How do you choose a TTL for a JavaScript bundle, an HTML entry document, and an API response that changes every minute?",
    difficulty: 2,
    hints: [
      "Start from the acceptable stale window.",
      "Content-addressed assets can have a very long TTL.",
    ],
    answer:
      "I choose the TTL from the acceptable stale window and the object's identity. A content-addressed bundle never changes under the same URL, so it can have a very long TTL, often a year, with `immutable` in `Cache-Control`. The HTML entry document changes when the bundle reference changes, so it needs a short TTL or a targeted purge; it is the object that makes the release visible. An API response that changes every minute needs a TTL at or below that interval, plus revalidation, or it should not be cached. The tradeoff is origin load: every shorter TTL moves refresh traffic to the origin, so I measure the refresh rate and the hit rate together.",
    followUps: [
      "What does `stale-while-revalidate` change?",
      "How would you handle a per-tenant API response?",
      "What would make you choose purge over a shorter TTL?",
    ],
    redFlags: [
      "Uses one TTL for every object type.",
      "Sets a long TTL on mutable HTML.",
      "Ignores origin refresh cost.",
    ],
    rubric: [
      "Ties TTL to the acceptable stale window.",
      "Separates immutable assets from entry documents.",
      "Names revalidation or purge as a complement.",
      "Measures origin cost.",
    ],
  },
  {
    id: "purge-vs-version",
    question:
      "When is a purge the right tool, and when is a versioned URL better? Give an operational reason for each.",
    difficulty: 3,
    hints: [
      "A purge changes an existing key; a version changes the key.",
      "Think about the entry document and the asset separately.",
    ],
    answer:
      "A purge is right when the URL cannot change: a regulatory page, a tenant-specific document, or an API path that clients already call. It is also right for a small, targeted set of objects where the propagation window is acceptable. A versioned URL is better for static assets because it removes the purge from the release path and makes the old object harmless. Operationally, purges require scope design, propagation monitoring, and a rollback plan; versioning requires build output, storage, and reference updates. Most systems use both: versioned assets plus a short TTL or targeted purge for the entry document.",
    followUps: [
      "How would you purge a page that is cached under three query variants?",
      "What is the rollback plan if a purge propagates partially?",
      "How do cache tags change the scope decision?",
    ],
    redFlags: [
      "Treats purge and versioning as interchangeable.",
      "Purges everything for every release.",
      "Ignores propagation and rollback.",
    ],
    rubric: [
      "Distinguishes key change from key invalidation.",
      "Names a case for each.",
      "Includes propagation and rollback.",
      "Combines both for assets and entry documents.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each object class has a TTL tied to its acceptable stale window.",
      "Static assets are content-addressed; entry documents have a separate policy.",
      "Purge scope and tag conventions are documented and tested in staging.",
      "Regional synthetic checks compare the deployed version marker.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check `Age`, `Cache-Control`, and cache status by region before purging again.",
      "Confirm the purge scope matches the actual cache key, including query variants and rewrites.",
      "Separate stale assets from a stale entry document.",
      "Measure stale requests, not only stale minutes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the purge IDs, scopes, and regional completion times.",
      "Remove old versions on a retention schedule.",
      "Add a release check that fails if any region still serves the old marker.",
      "Review whether the release can move to versioned URLs.",
    ],
  },
];

const references = [
  {
    title: "Invalidate files to remove content",
    url: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Invalidation.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "CloudFront invalidation paths, wildcard behavior, asynchronous processing, and charges beyond the free allocation.",
  },
  {
    title: "Purge cache",
    url: "https://developers.cloudflare.com/cache/how-to/purge-cache/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Purge by URL, tag, host, and prefix; purge everything; propagation and limits.",
  },
  {
    title: "Learn about Akamai's caching",
    url: "https://techdocs.akamai.com/property-mgr/docs/know-caching",
    publisher: "Akamai",
    kind: "docs" as const,
    note: "TTL, prefresh, cache keys, and how purge complements TTL.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "ttl-purge": {
      model: cdnTtlPurgeModel,
      presets,
      instructions:
        "Start Healthy, then apply Long TTL, no purge. Watch stale responses reach 100% while hit rate stays high. Apply Short TTL and compare origin load. Apply Versioned release and verify that stale responses fall to zero without a purge.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Object count, origin capacity, and the 90-second purge propagation window are teaching values, not provider guarantees. CloudFront and Cloudflare purge behavior depends on scope, plan, and current edge state.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-cdn-cache-keys",
    "traffic-origin-shield",
    "traffic-edge-provider-behavior",
    "foundations-cache-invalidation",
  ],
};
