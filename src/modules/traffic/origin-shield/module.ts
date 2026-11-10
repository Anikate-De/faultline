import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ORIGIN_CAPACITY = 200;
const EDGE_FILL_SECONDS = 0.2;
const ORIGIN_LATENCY_MS = 120;
const SHIELD_HOP_MS = 25;

const params = [
  {
    id: "edgePops",
    label: "Edge locations",
    min: 5,
    max: 200,
    step: 5,
    value: 20,
    unit: "",
    group: "Topology",
    help: "Independent edge caches serving the same object. Each one can miss on its own when its copy expires.",
    format: "count" as const,
  },
  {
    id: "objectRps",
    label: "Object request rate",
    min: 1_000,
    max: 100_000,
    step: 1_000,
    value: 30_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second for the popular object across all edges. More requests per edge means more concurrent misses during a fill.",
    format: "rps" as const,
  },
  {
    id: "ttlSeconds",
    label: "Object TTL",
    min: 10,
    max: 600,
    step: 10,
    value: 300,
    unit: " s",
    group: "Freshness",
    help: "How often each edge expires the object. A shorter TTL makes expiries more frequent, but does not make a single expiry smaller.",
    format: "number" as const,
  },
  {
    id: "collapseEnabled",
    label: "Edge request collapsing (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Collapsing",
    help: "One means concurrent misses for the same key at one edge share a single upstream fetch. Zero means each concurrent request can start its own fetch.",
    format: "count" as const,
  },
  {
    id: "shieldEnabled",
    label: "Origin shield (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Collapsing",
    help: "One adds a regional cache between the edges and the origin. Edge misses hit the shield; the shield collapses them into one origin fetch.",
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
  edgePops: number;
  objectRps: number;
  ttl: number;
  collapse: boolean;
  shield: boolean;
  perEdgeRps: number;
  missesPerEdge: number;
  edgeMisses: number;
  originBurst: number;
  originRps: number;
  originUtil: number;
  shieldInbound: number;
  p99: number;
}

function compute(p: Params): Computed {
  const edgePops = Math.max(1, Math.round(num(p, "edgePops", 20)));
  const objectRps = Math.max(1, num(p, "objectRps", 30_000));
  const ttl = Math.max(1, num(p, "ttlSeconds", 300));
  const collapse = num(p, "collapseEnabled", 1) >= 0.5;
  const shield = num(p, "shieldEnabled", 0) >= 0.5;
  const perEdgeRps = objectRps / edgePops;
  const missesPerEdge = collapse ? 1 : Math.max(1, perEdgeRps * EDGE_FILL_SECONDS);
  const edgeMisses = edgePops * missesPerEdge;
  const originBurst = shield ? 1 : edgeMisses;
  const originRps = originBurst / ttl;
  const originUtil = (originRps / ORIGIN_CAPACITY) * 100;
  const shieldInbound = shield ? edgeMisses / ttl : 0;
  const queueing =
    originUtil > 85 ? Math.min(600, ((originUtil - 85) / 15) * 120) : 0;
  const p99 = ORIGIN_LATENCY_MS + (shield ? SHIELD_HOP_MS : 0) + queueing;
  return {
    edgePops,
    objectRps,
    ttl,
    collapse,
    shield,
    perEdgeRps,
    missesPerEdge,
    edgeMisses,
    originBurst,
    originRps,
    originUtil,
    shieldInbound,
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

function worst(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function buildFrame(d: Computed, seed: number): SimFrame {
  const originHealth = worst(
    healthFor(d.originUtil, 70, 90),
    healthFor(d.originBurst, 5_000, 15_000),
  );
  const edgeHealth = healthFor(d.p99, 300, 700);
  const shieldHealth = d.shield ? healthFor(d.shieldInbound, 400, 800) : "ok";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      throughput: d.objectRps,
      sublabel: `${formatCount(d.objectRps)} rps for one object`,
      meta: { view: "flow" },
    },
    {
      id: "edge",
      label: "Edge fleet",
      kind: "cdn" as const,
      health: edgeHealth,
      utilization: clamp(d.perEdgeRps / 20_000),
      throughput: d.objectRps,
      sublabel: `${d.edgePops} PoPs · ${formatCount(d.perEdgeRps)} rps each`,
      detail: `Each edge has its own cache. ${d.collapse ? "Concurrent misses at one edge collapse to one upstream fetch." : "Each concurrent miss can start its own upstream fetch."}`,
      meta: { view: "flow", pops: d.edgePops },
    },
    ...(d.shield
      ? [
          {
            id: "shield",
            label: "Origin shield",
            kind: "cache" as const,
            health: shieldHealth,
            utilization: clamp(d.shieldInbound / 1_000),
            throughput: d.shieldInbound,
            sublabel: `${formatCount(d.shieldInbound)} rps inbound`,
            detail: "Regional cache between the edge fleet and the origin. It absorbs edge misses and forwards one fetch per object to the origin.",
            meta: { view: "flow" },
          },
        ]
      : []),
    {
      id: "origin",
      label: "Origin",
      kind: "service" as const,
      health: originHealth,
      utilization: clamp(d.originUtil / 100),
      throughput: d.originRps,
      capacity: ORIGIN_CAPACITY,
      sublabel: `${formatCount(d.originRps)} rps average`,
      detail: `${formatCount(d.originBurst)} concurrent origin fetches at expiry against an illustrative capacity of ${formatCount(ORIGIN_CAPACITY)} rps.`,
      meta: { view: "flow" },
    },
  ];
  const edges = [
    edge("client-edge", "client", "edge", d.objectRps / 100_000, edgeHealth),
    ...(d.shield
      ? [
          edge("edge-shield", "edge", "shield", d.shieldInbound / 1_000, shieldHealth),
          edge("shield-origin", "shield", "origin", d.originRps / 200, originHealth),
        ]
      : [edge("edge-origin", "edge", "origin", d.originRps / 200, originHealth)]),
  ];
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("origin-burst", "Concurrent origin fetches at expiry", d.originBurst, " req", 5_000, 15_000, "count"),
      metric("origin-rps", "Average origin requests", d.originRps, " rps", 40, 80, "rps"),
      metric("p99", "Object p99", d.p99, " ms", 300, 700, "ms"),
      metric("shield-inbound", "Shield inbound requests", d.shieldInbound, " rps", 400, 800, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      pops: d.edgePops,
      collapse: d.collapse ? 1 : 0,
      shield: d.shield ? 1 : 0,
      burst: d.originBurst,
    },
    summary: `${d.edgePops} PoPs request the object at ${formatCount(d.objectRps)} rps. ${formatCount(d.originBurst)} concurrent origin fetch(es) at expiry; ${d.originRps.toFixed(2)} rps average; p99 ${Math.round(d.p99)} ms.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.04 * Math.sin((index + (seed % 7)) / 2.5)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "origin-burst",
    metricId: "origin-burst",
    warn: 5_000,
    crit: 15_000,
    title: "Object expiry triggered an origin request storm",
    cause:
      "Many edges expired the same object at once. Without collapsing, every concurrent miss can become its own origin fetch; even with per-edge collapsing, each edge still sends one fetch.",
    fix:
      "Enable request collapsing at the edge and add an origin shield so the edges share one upstream fetch. Add TTL jitter to spread expiries across edges; it does not reduce the total number of misses.",
    checkFirst: [
      "Align the origin spike with the object's TTL expiry time.",
      "Count cache misses by edge location, not only in aggregate.",
      "Check whether request collapsing and the origin shield are enabled for this cache behavior.",
    ],
  },
  {
    id: "origin-rps",
    metricId: "origin-rps",
    warn: 40,
    crit: 80,
    title: "The origin is absorbing repeated miss bursts",
    cause:
      "A short TTL or a large edge fleet turns a single object's expiry into frequent origin traffic. The average rate can look small while each burst is large enough to queue.",
    fix:
      "Increase the TTL where freshness allows, enable collapsing and a shield, and stagger expiry times. If the object is truly uncacheable, protect the origin with a request queue and a bounded concurrency limit.",
    checkFirst: [
      "Compare origin request rate with the TTL and the number of edges.",
      "Check whether the origin sees synchronized bursts or a steady rate.",
      "Check origin concurrency and queueing, not only average RPS.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 700,
    title: "Object p99 crossed the latency objective",
    cause:
      "Origin fetches are queueing behind the miss burst. A shield adds a network hop, so it can reduce origin load while slightly increasing the best-case latency.",
    fix:
      "Collapse the misses and add capacity only after the burst is bounded. Place the shield near the origin or the traffic concentration, and measure the hop separately from origin queueing.",
    checkFirst: [
      "Compare edge p99 with origin response time for the same window.",
      "Check whether latency spikes align with TTL expiry.",
      "Check the shield region and the edge-to-shield path.",
    ],
  },
  {
    id: "shield-inbound",
    metricId: "shield-inbound",
    warn: 400,
    crit: 800,
    title: "The shield is carrying too many edge misses",
    cause:
      "The shield protects the origin by absorbing edge requests, but it still has to serve every edge miss. With edge collapsing off, the shield sees the full fan-in.",
    fix:
      "Enable request collapsing at the edge as well as at the shield, add TTL jitter, or increase shield capacity. A shield is a cache tier, not an infinite buffer.",
    checkFirst: [
      "Compare shield inbound rate with the edge miss rate.",
      "Check whether edge collapsing is on for the same object.",
      "Check shield CPU, connection count, and cache eviction rate.",
    ],
  },
];

export const originShieldModel: SimModel = {
  id: "traffic-origin-shield",
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
    const previousShield = Number(frame.flags.shield ?? 0);
    const previousCollapse = Number(frame.flags.collapse ?? 1);
    if ((d.shield ? 1 : 0) !== previousShield) {
      pushEvent(next, {
        id: d.shield ? "shield-enabled" : "shield-disabled",
        at: frame.t,
        severity: "info",
        title: d.shield ? "Origin shield added to the path" : "Origin shield removed from the path",
        detail: d.shield
          ? `Edge misses now hit the shield, which forwards one fetch per object to the origin. Shield inbound load is ${formatCount(d.shieldInbound)} rps.`
          : "Edge misses now go directly to the origin. Each edge's concurrent misses can multiply the origin burst again.",
        nodeId: d.shield ? "shield" : "origin",
        metricId: "origin-burst",
      });
    }
    if ((d.collapse ? 1 : 0) !== previousCollapse) {
      pushEvent(next, {
        id: d.collapse ? "collapse-enabled" : "collapse-disabled",
        at: frame.t,
        severity: d.collapse ? "info" : "warn",
        title: d.collapse ? "Edge request collapsing enabled" : "Edge request collapsing disabled",
        detail: d.collapse
          ? "Concurrent misses for the same key at one edge now share a single upstream fetch."
          : `Each concurrent miss can start its own fetch. This edge will send about ${formatCount(d.missesPerEdge)} requests per expiry.`,
        nodeId: "edge",
        metricId: "origin-burst",
      });
    }
    if (d.originBurst >= 15_000 && frame.flags.expiryStorm !== 1) {
      pushEvent(next, {
        id: "expiry-storm",
        at: frame.t,
        severity: "crit",
        title: "Popular object expired across the edge fleet",
        detail: `${formatCount(d.originBurst)} concurrent origin fetches at expiry. The object is requested at ${formatCount(d.objectRps)} rps with a ${formatCount(d.ttl)}s TTL.`,
        nodeId: "origin",
        metricId: "origin-burst",
      });
      next.flags.expiryStorm = 1;
    }
    if (d.originBurst < 15_000) next.flags.expiryStorm = 0;
    if (d.shieldInbound >= 800 && frame.flags.shieldOverload !== 1) {
      pushEvent(next, {
        id: "shield-overload",
        at: frame.t,
        severity: "warn",
        title: "Shield inbound load is high",
        detail: `The shield is receiving ${formatCount(d.shieldInbound)} rps from edge misses. Enable edge collapsing or add shield capacity before the origin is protected at the shield's expense.`,
        nodeId: "shield",
        metricId: "shield-inbound",
      });
      next.flags.shieldOverload = 1;
    }
    if (d.shieldInbound < 800) next.flags.shieldOverload = 0;
    next.flags.pops = d.edgePops;
    next.flags.collapse = d.collapse ? 1 : 0;
    next.flags.shield = d.shield ? 1 : 0;
    next.flags.burst = d.originBurst;
    next.summary = `${d.edgePops} PoPs request the object at ${formatCount(d.objectRps)} rps. ${formatCount(d.originBurst)} concurrent origin fetch(es) at expiry; ${d.originRps.toFixed(2)} rps average; p99 ${Math.round(p99)} ms.`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `${formatCount(d.perEdgeRps)} rps per edge. ${d.collapse ? "Collapsing lets one fetch serve the concurrent misses at that edge." : `Without collapsing, about ${formatCount(d.missesPerEdge)} concurrent misses can leave each edge per expiry.`}`,
    );
    items.push(
      `The object expires every ${formatCount(d.ttl)}s. That frequency changes how often the burst happens, not how large one burst is.`,
    );
    if (d.shield) {
      items.push(
        `The shield receives ${formatCount(d.shieldInbound)} rps of edge misses and sends ${d.originRps.toFixed(2)} rps to the origin. It collapses the fan-in, but it is now a cache tier with its own capacity.`,
      );
      items.push(
        `The shield adds about ${SHIELD_HOP_MS} ms in this model. That is the latency price of centralizing the fetch.`,
      );
    } else {
      items.push(
        "Without a shield, the origin sees the sum of every edge's misses. Per-edge collapsing bounds each edge, not the fleet.",
      );
    }
    if (d.originBurst > 1) {
      items.push(
        `One expiry produces ${formatCount(d.originBurst)} concurrent origin fetches. Origin capacity has to cover the burst, not just the average.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Miss burst", tone: "warn" },
    { label: "Origin storm", tone: "crit" },
    { label: "Shield hop", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Twenty edges, one object, and per-edge collapsing. The origin sees one fetch per edge per expiry.",
    tone: "ok",
    params: defaults({ edgePops: 20, objectRps: 30_000, ttlSeconds: 300, collapseEnabled: 1, shieldEnabled: 0 }),
  },
  {
    id: "peak",
    label: "Collapse off",
    description: "Forty edges with collapsing off. Concurrent misses multiply and both the burst and origin rate warn.",
    tone: "warn",
    params: defaults({ edgePops: 40, objectRps: 30_000, ttlSeconds: 120, collapseEnabled: 0, shieldEnabled: 0 }),
  },
  {
    id: "failure",
    label: "Expiry storm",
    description: "One hundred edges, a 30-second TTL, and no collapsing. The origin is hit by thousands of concurrent fetches.",
    tone: "crit",
    params: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 0, shieldEnabled: 0 }),
  },
  {
    id: "collapse-only",
    label: "Collapse only",
    description: "Per-edge collapsing bounds each PoP to one fetch; the fleet still sends one per edge.",
    tone: "ok",
    params: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 1, shieldEnabled: 0 }),
  },
  {
    id: "shield-only",
    label: "Shield, no edge collapse",
    description: "The shield collapses the fan-in, but it must absorb every edge miss itself.",
    tone: "warn",
    params: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 0, shieldEnabled: 1 }),
  },
  {
    id: "recovery",
    label: "Shield + collapse",
    description: "The edges collapse locally and the shield collapses the remainder into one origin fetch.",
    tone: "ok",
    params: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 1, shieldEnabled: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-shield",
  title: "Predict what an origin shield changes at expiry",
  simId: "origin-shield",
  question:
    "A popular object expires across 100 edges. With edge collapsing off, each edge can send about 160 concurrent requests to the origin. What does adding an origin shield change?",
  prediction: {
    options: [
      { id: "one-fetch", label: "The shield collapses the edge misses into one origin fetch, but it absorbs the fan-in itself." },
      { id: "latency-zero", label: "It removes the origin burst and also removes the extra network hop." },
      { id: "ttl", label: "It lengthens the TTL, so the object expires less often." },
      { id: "edge-capacity", label: "It adds edge cache capacity, so each edge can hold more objects." },
    ],
    correctOptionId: "one-fetch",
    explanation:
      "The shield is a cache tier between the edges and the origin. It receives the edge misses, collapses concurrent requests for the same object, and sends one fetch to the origin. It does not change the object's TTL or add edge capacity, and it adds a hop, so best-case latency rises slightly. The shield's own inbound rate is the fan-in it must absorb.",
  },
  setup: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 0, shieldEnabled: 0 }),
  runFor: 20,
  observe: [
    "The setup shows the storm: about 16,000 concurrent origin fetches and 533 rps average to the origin.",
    "Adding only the shield reduces the origin to one fetch per expiry, but shield inbound is still about 533 rps.",
    "Adding edge collapsing as well reduces shield inbound to about 3 rps and origin requests to a fraction of a request per second.",
    "p99 falls from about 720 ms to about 145 ms once the shield is in place; the shield hop adds about 25 ms to a miss.",
  ],
  explain:
    "Without a shield, the origin receives the sum of every edge's concurrent misses. The shield gives the edges one shared place to miss into. It collapses those misses into one origin fetch, so the origin sees one request per expiry instead of thousands. The cost is a new tier: it must handle the combined edge miss rate, it adds a hop, and if it is unavailable the origin sees the full fan-in again.",
  fix: defaults({ edgePops: 100, objectRps: 80_000, ttlSeconds: 30, collapseEnabled: 1, shieldEnabled: 1 }),
  debrief:
    "With edge collapsing and a shield, the burst reaches the origin as one fetch and the shield inbound rate falls to about 3 rps. The origin is protected and p99 is about 145 ms. The tradeoff is a regional dependency and an extra hop; the shield must be sized for the fan-in and monitored like any other cache tier. TTL jitter would spread the expiry across edges if each edge gets an independent offset, but it would not reduce the total number of misses.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An origin shield is an additional cache tier between the edge locations and the origin. Edge locations still cache the object, but when an edge misses, it asks the shield instead of the origin. The shield keeps its own copy and, when it also misses, fetches once from the origin. Request collapsing is the related mechanism: when several requests for the same cache key arrive while a fetch is already in flight, they wait for that fetch instead of starting their own. CloudFront documents request collapsing at edge locations; an origin shield extends the same idea across edges.",
  },
  {
    type: "p",
    text: "A cache miss storm, also called a stampede, happens when many caches expire the same popular object at nearly the same time. Each edge has an independent TTL clock. If the object was cached at the same time everywhere, every edge can miss together. Per-edge collapsing limits the damage at one location: one fetch serves all concurrent requests at that edge. It does not limit the fleet: 100 edges can still send 100 fetches. A shield gives those 100 edges one shared place to collapse.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path becomes client, edge location, origin shield, origin. The shield is usually regional. Its placement is a latency decision: near the origin reduces origin round trips, while near the traffic concentration reduces edge-to-shield time. The shield is not a queue and not extra origin capacity. It is a cache with its own hit rate, eviction, connection limits, and failure mode. If the shield is cold or unavailable, the origin sees the fan-in that the shield was supposed to absorb.",
  },
  {
    type: "compare",
    leftTitle: "No control",
    rightTitle: "Shield + collapsing",
    rows: [
      { label: "Origin fetches per expiry", left: "One per concurrent miss, multiplied by every edge", right: "One total, shared by all edges" },
      { label: "Best-case latency", left: "Origin round trip", right: "Origin round trip plus the shield hop" },
      { label: "Failure domain", left: "Origin capacity must cover the burst", right: "Shield capacity and availability become part of the path" },
      { label: "Cache tiers", left: "One edge tier", right: "Edge tier plus a regional tier" },
    ],
  },
  {
    type: "p",
    text: "The design question is where the fan-in should stop. Per-edge collapsing stops it at each PoP. A shield stops it at a region. A queue at the origin stops it at the last possible point, but the requests are already consuming connections and time. The earlier the collapse, the less work the origin and the network do; the later the collapse, the fewer new components are in the request path.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Concurrent origin fetches at expiry, the burst that average RPS hides.",
      "Average origin request rate, which shows how often the burst happens.",
      "Shield inbound requests, the fan-in the shield has to absorb.",
      "Object p99, including the shield hop and any origin queueing.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Expiry storm. Note the concurrent origin fetches and the average rate. Apply Collapse only: each edge sends one fetch, so the fleet still sends one per edge. Apply Shield, no edge collapse and then Shield + collapse. Compare origin burst, shield inbound, and p99 before deciding that the origin is the only component to protect.",
  },
  {
    type: "table",
    headers: ["Control", "What it collapses", "What it costs"],
    rows: [
      ["Per-edge request collapsing", "Concurrent misses at one edge", "One fetch per edge per expiry; no cross-edge sharing"],
      ["Origin shield", "Edge misses into one regional fetch", "An extra hop, a new cache tier, and a regional failure domain"],
      ["TTL jitter", "Synchronized expiry across edges", "Spreads the burst across time; total misses are unchanged, and the offset must differ per edge"],
      ["Origin concurrency limit", "Fetches that reach the origin at once", "Queues or sheds requests; protects the origin but adds latency"],
    ],
  },
  {
    type: "p",
    text: "The first question is whether the burst is per edge or across the fleet. Per-edge collapsing is cheap and local; a shield is a shared tier with shared capacity. The second question is whether the shield can absorb the fan-in it is asked to collapse. A shield that protects the origin by becoming the bottleneck has moved the incident, not removed it.",
  },
  { type: "sim", simId: "origin-shield" },
  { type: "experiment", experimentId: "predict-shield" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset used 100 edges, an 80,000 rps object, a 30-second TTL, and no collapsing. Each edge could start about 160 fetches during the fill, so the origin saw roughly 16,000 concurrent requests at every expiry. The average rate was about 533 rps, which is high but still hides the shape of the event. The origin queue produced a p99 near 720 ms. The object itself was healthy; the miss pattern was the problem.",
  },
  {
    type: "p",
    text: "Per-edge collapsing reduced each edge to one fetch, so the fleet sent 100. The shield reduced those 100 to one origin fetch, but it had to absorb 533 rps of edge misses itself. Combining edge collapsing and the shield reduced shield inbound to about 3 rps and origin burst to one. The origin was protected, the shield stayed small, and the only added cost was the hop.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CDN cache statistics: miss rate and origin fetches by edge location, aligned with the object's TTL.",
      "Origin logs: a burst of identical requests at the same timestamp, often with the same object key.",
      "Shield metrics: inbound request rate, cache hit rate, eviction rate, CPU, and connection count.",
      "Latency: edge p99 split into edge processing, shield time, and origin response time.",
      "Cache status: a burst of `MISS` or `EXPIRED` at many edges at once is the signature; a single edge with misses is a different problem.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the origin burst aligns with a TTL expiry and whether it appears at many edges at once. Then check whether request collapsing is enabled for that cache behavior. If a shield is present, check its inbound rate before assuming it is protecting the origin; the fan-in may have moved to the shield.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the burst is a cache miss storm, not an origin slowdown or a traffic spike.",
      "Enable per-edge request collapsing for the object.",
      "Add an origin shield when the fleet, not one edge, is the source of the fan-in.",
      "Add TTL jitter for objects that expire together, and prefetch hot objects before they expire.",
      "Size and monitor the shield for the inbound fan-in, and verify the origin burst after each change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shield reduces origin load but adds a network hop and a regional dependency.",
      "Per-edge collapsing is local and cheap, but it cannot share a fetch across edges.",
      "TTL jitter spreads expiry across edges when each edge gets an independent offset; it does not reduce total miss work, and a shared offset does not help.",
      "A shield can become a bottleneck if it is sized for origin traffic rather than edge fan-in.",
      "Origin concurrency limits protect the origin but turn a burst into a queue; the queue still has a latency cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-miss-storm",
    question:
      "The origin sees a burst of identical requests every five minutes, and edge hit rate looks normal between bursts. How do you diagnose it?",
    difficulty: 3,
    hints: [
      "Align the burst with the object's TTL.",
      "Count misses by edge, not only in aggregate.",
    ],
    answer:
      "I would align the burst timestamps with the object's TTL and check whether many edges expire it together. A normal aggregate hit rate can hide a synchronized miss because the burst is short relative to the TTL. I would count origin fetches by edge and by object key, then check whether request collapsing is enabled. If each edge sends one fetch, the next question is whether a shield would collapse the fleet. If each edge sends many, per-edge collapsing is the first fix. I would also check TTL jitter and whether the object was cached everywhere at the same time.",
    followUps: [
      "What would make you choose a shield over per-edge collapsing?",
      "How would you tell a miss storm from an origin slowdown?",
      "What metric would you alert on?",
    ],
    redFlags: [
      "Adds origin capacity without checking the miss pattern.",
      "Looks only at average hit rate.",
      "Assumes a shield is free capacity.",
    ],
    rubric: [
      "Aligns bursts with TTL expiry.",
      "Counts misses by edge and key.",
      "Separates per-edge from fleet-wide fan-in.",
      "Names a collapsing fix and a verification.",
    ],
  },
  {
    id: "shield-capacity",
    question:
      "You add an origin shield and the origin is protected, but the shield's CPU is at 95%. What went wrong in the design?",
    difficulty: 3,
    hints: [
      "The shield absorbs edge misses before it collapses them.",
      "Edge collapsing and shield collapsing are different layers.",
    ],
    answer:
      "The shield was sized for origin traffic, not for the edge fan-in. It has to receive every edge miss before it can collapse them, so its inbound rate is the sum of the edge miss rates, not the origin rate. If edge collapsing is off, the shield sees every concurrent request from every edge. The fix is to enable edge collapsing first, add TTL jitter or prefetch to reduce synchronized misses, and size the shield for the remaining fan-in. Adding shield capacity without reducing the fan-in can work, but it treats the symptom and leaves a larger failure domain.",
    followUps: [
      "How would you measure the shield's safe inbound rate?",
      "What happens to the origin if the shield fails?",
      "Where would you place the shield?",
    ],
    redFlags: [
      "Says the shield only sees origin traffic.",
      "Adds capacity without checking edge collapsing.",
      "Ignores the shield failure mode.",
    ],
    rubric: [
      "Explains shield inbound fan-in.",
      "Separates edge and shield collapsing.",
      "Sizes the shield for fan-in.",
      "Names the failure mode.",
    ],
  },
  {
    id: "latency-tradeoff",
    question:
      "An origin shield adds 25 ms to every miss. When is that trade worth it, and when is it not?",
    difficulty: 2,
    hints: [
      "Compare the hop with the origin queue it prevents.",
      "A hit at the edge does not pay the hop.",
    ],
    answer:
      "The hop is paid only on a miss that reaches the shield, not on an edge hit. It is worth it when the origin is queueing under miss bursts, when the shield turns many edge fetches into one, or when the shield is closer to the origin than the edge is. It is not worth it when the object is rarely requested, when the origin has ample capacity and low latency, or when the shield's region adds more distance than it saves. I would compare p99 with and without the shield under the same miss pattern, not just the best-case latency.",
    followUps: [
      "How would you measure the shield's contribution to p99?",
      "What objects would you exclude from the shield?",
      "How does shield placement change the answer?",
    ],
    redFlags: [
      "Compares only average latency.",
      "Ignores the origin queue that the shield prevents.",
      "Assumes every request pays the hop.",
    ],
    rubric: [
      "Notes that edge hits skip the hop.",
      "Compares burst latency, not only averages.",
      "Considers origin queueing.",
      "Relates placement to latency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Request collapsing is enabled for hot, cacheable objects.",
      "Origin shield placement and capacity are documented for each region.",
      "TTL jitter or prefetch is configured for objects that expire together.",
      "Dashboards show origin fetches by edge, shield inbound rate, and p99.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Align the origin burst with the object's TTL and edge locations.",
      "Check whether collapsing is on at the edge and at the shield.",
      "Watch shield inbound rate before declaring the origin protected.",
      "Bound origin concurrency so a burst cannot consume every connection.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a synthetic check that measures origin bursts at expiry.",
      "Review shield capacity against the measured fan-in.",
      "Prefetch or stagger expiry for the hottest objects.",
      "Record the latency cost of the shield hop in the SLO review.",
    ],
  },
];

const references = [
  {
    title: "Use Origin Shield",
    url: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-shield.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "CloudFront Origin Shield as an additional caching layer that reduces origin load and centralizes requests.",
  },
  {
    title: "Request and response behavior for custom origins",
    url: "https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/RequestAndResponseBehaviorCustomOrigin.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Request collapsing: simultaneous requests for the same object share one origin fetch.",
  },
  {
    title: "Tiered Cache",
    url: "https://developers.cloudflare.com/cache/how-to/tiered-cache/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Upper-tier caches between edge locations and the origin, and the hit-ratio and origin-load tradeoff.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "origin-shield": {
      model: originShieldModel,
      presets,
      instructions:
        "Start Healthy, then apply Expiry storm. Watch concurrent origin fetches and average rate. Apply Collapse only, then Shield, no edge collapse, then Shield + collapse. Compare origin burst, shield inbound, and p99.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Edge fill time, origin capacity, shield hop latency, and the two collapsing layers are teaching values, not provider guarantees. Check the current behavior of your CDN's collapsing and shield features.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-caching-strategies",
    "traffic-cdn-cache-keys",
    "traffic-cdn-ttl-purge",
    "caching-cache-stampede",
  ],
};
