import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "primaryHealthy",
    label: "Primary region healthy (0 fail, 1 healthy)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failure",
    help: "1 leaves both regions available. 0 injects a primary-region failure at the start of the scenario so the failover clock begins.",
    format: "count",
  },
  {
    id: "recordTtl",
    label: "Record TTL",
    min: 30,
    max: 3_600,
    step: 30,
    value: 300,
    unit: " s",
    group: "DNS",
    help: "The time Route 53 tells recursive resolvers they may cache the answer. A lower TTL shortens stale answers but increases query volume. This is a teaching value, not a recommended universal TTL.",
    format: "number",
  },
  {
    id: "appCacheSeconds",
    label: "Application DNS cache",
    min: 0,
    max: 3_600,
    step: 30,
    value: 30,
    unit: " s",
    group: "DNS",
    help: "An application or runtime cache that outlives the resolver. A JVM can cache positive lookups for an implementation-specific period unless networkaddress.cache.ttl is set.",
    format: "number",
  },
  {
    id: "detectionSeconds",
    label: "Health check detection",
    min: 10,
    max: 120,
    step: 10,
    value: 30,
    unit: " s",
    group: "DNS",
    help: "Illustrative time for health checks to mark the primary unhealthy and for Route 53 to start returning the secondary. Real detection depends on interval, failure threshold, and how many checker locations observe the failure.",
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
  healthy: boolean;
  ttl: number;
  appCache: number;
  detection: number;
  cacheWindow: number;
  totalFailover: number;
  elapsed: number;
  stale: number;
  failoverRemaining: number;
  secondaryUtil: number;
}

function compute(p: Params, t: number, incidentStart: number): Computed {
  const healthy = num(p, "primaryHealthy", 1) >= 0.5;
  const ttl = Math.max(30, num(p, "recordTtl", 300));
  const appCache = Math.max(0, num(p, "appCacheSeconds", 30));
  const detection = Math.max(0, num(p, "detectionSeconds", 30));
  const cacheWindow = Math.max(ttl, appCache);
  const totalFailover = healthy ? 0 : detection + cacheWindow;
  const elapsed = healthy ? 0 : Math.max(0, t - incidentStart);
  const stale = healthy
    ? 0
    : elapsed < detection
      ? 1
      : clamp(1 - (elapsed - detection) / Math.max(1, cacheWindow), 0, 1);
  const failoverRemaining = healthy ? 0 : Math.max(0, totalFailover - elapsed);
  return {
    healthy,
    ttl,
    appCache,
    detection,
    cacheWindow,
    totalFailover,
    elapsed,
    stale,
    failoverRemaining,
    secondaryUtil: healthy ? 0 : (1 - stale) * 70,
  };
}

function buildFrame(p: Params, t: number, incidentStart: number, seed: number): SimFrame {
  const c = compute(p, t, incidentStart);
  const stalePercent = c.stale * 100;
  const clientHealth: Health = stalePercent > 10 ? "crit" : stalePercent > 1 ? "warn" : "ok";
  const cacheHint = c.appCache > c.ttl ? "application cache dominates" : "resolver TTL dominates";
  return {
    t,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        sublabel: `${stalePercent.toFixed(0)}% still use the failed region`,
        detail:
          "Clients only learn a new address when their resolver asks again and when the application asks its resolver again. An open TCP connection can keep using the old address even after the record changes.",
        meta: { view: "flow" },
      },
      {
        id: "resolver",
        label: "Recursive resolver",
        kind: "dns",
        health: clientHealth,
        utilization: clamp(c.stale),
        sublabel: `TTL ${formatCount(c.ttl)}s · app cache ${formatCount(c.appCache)}s`,
        detail: `The effective cache window is the larger of the record TTL and the application cache: ${formatCount(c.cacheWindow)}s. ${cacheHint}.`,
        meta: { view: "flow" },
      },
      {
        id: "route53",
        label: "Route 53",
        kind: "dns",
        health: "ok",
        sublabel: c.healthy ? "returns primary" : c.elapsed < c.detection ? "has not detected failure" : "returns secondary",
        detail: c.healthy
          ? "The authoritative answer points at the primary region."
          : c.elapsed < c.detection
            ? "The health check has not marked the primary unhealthy yet, so Route 53 still returns the primary address."
            : "The health check is unhealthy, so new answers point at the secondary. Resolvers that already cached the old answer keep it until their copy expires.",
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Primary region",
        kind: "service",
        health: c.healthy ? "ok" : "down",
        utilization: c.healthy ? 0.45 : 0,
        sublabel: c.healthy ? "serving traffic" : "unavailable",
        detail: c.healthy
          ? "The primary is healthy and receives the authoritative answer."
          : "The primary is unavailable. Requests that still resolve to it fail until the client cache expires or the application reconnects.",
        meta: { view: "flow" },
      },
      {
        id: "secondary",
        label: "Secondary region",
        kind: "service",
        health: "ok",
        utilization: clamp(c.secondaryUtil / 100),
        sublabel: `${formatCount(c.secondaryUtil)}% of design load`,
        detail:
          "The secondary is sized for full production traffic at about 70% utilization in this model. It receives traffic only after clients stop using the old answer.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-resolver", "clients", "resolver", 1, clientHealth),
      edge("resolver-primary", "resolver", "primary", c.stale, c.healthy ? "ok" : "down"),
      edge("resolver-secondary", "resolver", "secondary", 1 - c.stale, "ok"),
    ],
    metrics: [
      metric("stale-clients", "Clients on stale answers", stalePercent, "%", 1, 10, "percent"),
      metric("failover-delay", "Failover delay remaining", c.failoverRemaining, " s", 60, 300, "number"),
      metric("secondary-utilization", "Secondary utilization", c.secondaryUtil, "%", undefined, undefined, "percent"),
      metric("effective-cache", "Effective cache window", c.cacheWindow, " s", undefined, undefined, "number"),
      metric("detection", "Detection before DNS change", c.detection, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.healthy
      ? `Primary healthy. If it failed, the model would need ${formatCount(c.detection + c.cacheWindow)}s to move clients: ${formatCount(c.detection)}s detection plus ${formatCount(c.cacheWindow)}s cache.`
      : `${stalePercent.toFixed(0)}% of clients still use the failed primary. Full failover needs ${formatCount(c.totalFailover)}s: ${formatCount(c.detection)}s detection plus ${formatCount(c.cacheWindow)}s cache.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-clients",
    metricId: "stale-clients",
    warn: 1,
    crit: 10,
    title: "Clients are still resolving to the failed region",
    cause:
      "Recursive resolvers or the application still hold the old answer. DNS failover is not a push: the record changed, but each cache keeps its copy until its own expiry time.",
    fix:
      "Measure the effective cache window, not only the record TTL. Lower the record TTL before the change, configure application and JVM caches, and drain or fail over the old region while clients catch up.",
    checkFirst: [
      "Compare the record TTL with the application or runtime DNS cache setting.",
      "Check whether clients hold open TCP connections to the old region.",
      "Confirm the health check actually marked the primary unhealthy before expecting a new answer.",
    ],
  },
  {
    id: "failover-delay",
    metricId: "failover-delay",
    warn: 60,
    crit: 300,
    title: "DNS failover exceeds the recovery objective",
    cause:
      "The remaining failover time is the health-check detection time plus the longest client cache. A long TTL or an application-level cache keeps the total above the RTO even when the record itself is correct.",
    fix:
      "Reduce detection time and cache lifetime, or move the entry point to a service that fails over without DNS, such as an anycast address with health-checked endpoints. Test the full client path, not only the resolver.",
    checkFirst: [
      "Read the configured TTL and the application cache side by side.",
      "Measure how long the health check takes to flip, including its failure threshold.",
      "Check for clients that pin an IP or reuse a connection pool across the failover.",
    ],
  },
];

export const dnsTtlFailoverModel: SimModel = {
  id: "traffic-dns-ttl-failover",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, 0, seed);
    for (const item of frame.metrics) {
      frame.series[item.id] = [item.value];
    }
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    const incidentStart = reset ? frame.t : Number(frame.flags.incidentStart ?? 0);
    const t = frame.t + dt;
    const c = compute(p, t, incidentStart);
    const next = buildFrame(p, t, incidentStart, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([id, values]) => [id, [...values]]));
    next.events = [...frame.events].slice(-60);
    next.flags = reset
      ? { ...next.flags, paramsKey: key, incidentStart, failureLogged: 0, staleLogged: 0, completeLogged: 0 }
      : { ...frame.flags, ...next.flags, paramsKey: key, incidentStart };
    if (!c.healthy && frame.flags.failureLogged !== 1) {
      pushEvent(next, {
        id: "primary-unavailable",
        severity: "crit",
        title: "Primary region is unavailable",
        detail: "The authoritative DNS answer still points at the primary until the health check flips. Clients holding a cached answer will keep trying the failed region.",
        nodeId: "primary",
        metricId: "stale-clients",
      });
      next.flags.failureLogged = 1;
      next.flags.completeLogged = 0;
    }
    if (!c.healthy && c.stale > 0.01 && next.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "cached-answer-stale",
        severity: "warn",
        title: "Resolvers are serving a cached answer",
        detail: `The effective cache window is ${formatCount(c.cacheWindow)}s: the larger of the ${formatCount(c.ttl)}s record TTL and the ${formatCount(c.appCache)}s application cache.`,
        nodeId: "resolver",
        metricId: "stale-clients",
      });
      next.flags.staleLogged = 1;
    }
    if (!c.healthy && c.stale === 0 && next.flags.completeLogged !== 1) {
      pushEvent(next, {
        id: "failover-complete",
        severity: "info",
        title: "Client caches have expired",
        detail: `New answers point at the secondary after ${formatCount(c.totalFailover)}s. Existing connections may still need to be drained or reconnected.`,
        nodeId: "secondary",
        metricId: "failover-delay",
      });
      next.flags.completeLogged = 1;
    }
    if (c.healthy && frame.flags.failureLogged === 1) {
      pushEvent(next, {
        id: "primary-restored",
        severity: "info",
        title: "Primary region restored",
        detail: "The model no longer injects a failure. TTL and application cache values still describe how long a future failover would take.",
        nodeId: "primary",
      });
      next.flags.failureLogged = 0;
      next.flags.staleLogged = 0;
      next.flags.completeLogged = 0;
    }
    const noise = rng.between(-0.004, 0.004);
    next.metrics = next.metrics.map((item) =>
      item.id === "secondary-utilization"
        ? { ...item, value: clamp(item.value + noise * 100, 0, 100) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p, 0, 0);
    const items: string[] = [];
    items.push(
      `The effective stale-answer window is ${formatCount(c.cacheWindow)}s, the larger of the ${formatCount(c.ttl)}s record TTL and the ${formatCount(c.appCache)}s application cache.`,
    );
    items.push(
      c.healthy
        ? `No failure is injected. If the primary failed now, full failover would take about ${formatCount(c.detection + c.cacheWindow)}s including detection.`
        : `Full failover takes about ${formatCount(c.totalFailover)}s: ${formatCount(c.detection)}s detection plus ${formatCount(c.cacheWindow)}s cache.`,
    );
    if (c.appCache > c.ttl) {
      items.push(
        "The application cache is longer than the record TTL, so lowering the TTL alone will not meet the objective. Set the runtime cache explicitly.",
      );
    } else if (c.ttl > c.appCache) {
      items.push(
        "The record TTL is the longest delay. Lower it before the change and wait at least the old TTL before declaring the new answer active.",
      );
    }
    items.push(
      "A DNS change does not close existing TCP connections. Clients with long-lived connections can keep using the old region even after a new lookup.",
    );
    if (c.secondaryUtil >= 60) {
      items.push(`The secondary is at ${c.secondaryUtil.toFixed(0)}% of its design load after the shift; confirm it has headroom.`);
    }
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
    description: "Both regions available, a 300s record TTL, and a short application cache.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Long cache, healthy",
    description: "Both regions available, but a one-hour TTL and one-hour application cache make the next failover slow.",
    tone: "warn",
    params: defaults({ recordTtl: 3_600, appCacheSeconds: 3_600, detectionSeconds: 60 }),
  },
  {
    id: "failure",
    label: "Stale answers",
    description: "The primary fails; a 300s TTL and 600s application cache keep clients on it for more than ten minutes.",
    tone: "crit",
    params: defaults({ primaryHealthy: 0, recordTtl: 300, appCacheSeconds: 600, detectionSeconds: 30 }),
  },
  {
    id: "app-cache",
    label: "JVM cache dominates",
    description: "The record TTL is 60s, but the application caches lookups for 900s. The TTL change does not meet the objective.",
    tone: "crit",
    params: defaults({ primaryHealthy: 0, recordTtl: 60, appCacheSeconds: 900, detectionSeconds: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The primary is healthy and the cache settings are short enough for a fast future failover.",
    tone: "ok",
    params: defaults({ primaryHealthy: 1, recordTtl: 30, appCacheSeconds: 30, detectionSeconds: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-effective-cache",
  title: "Predict why the TTL change did not help",
  simId: "dns-ttl-failover",
  question:
    "You lower the record TTL from 300s to 60s, but clients still take about 15 minutes to leave the failed region. What is the longest delay?",
  prediction: {
    options: [
      { id: "app-cache", label: "The application or JVM DNS cache is 900s, longer than the record TTL." },
      { id: "resolver-ignores", label: "Recursive resolvers ignore Route 53 TTL values." },
      { id: "health-check", label: "The health check takes 15 minutes to detect the failure." },
      { id: "capacity", label: "The secondary region cannot accept traffic for 15 minutes." },
    ],
    correctOptionId: "app-cache",
    explanation:
      "The record TTL is one cache in the path. A runtime can keep a successful lookup for its own period; the JVM property networkaddress.cache.ttl controls it, and the default is implementation-specific. If the application cache is 900s, a 60s record TTL changes the resolver layer but leaves the application holding the old address.",
  },
  setup: defaults({ primaryHealthy: 0, recordTtl: 60, appCacheSeconds: 900, detectionSeconds: 30 }),
  runFor: 30,
  observe: [
    "The total failover delay is about 930s even though the record TTL is 60s.",
    "Clients stay on stale answers for the whole 30s run; the remaining delay is still near 900s.",
    "The effective cache window reads 900s, not 60s.",
    "The secondary stays idle because no client has refreshed its lookup yet.",
  ],
  explain:
    "Route 53 tells resolvers they may cache the answer for the record TTL, but it cannot clear a cache inside the client runtime. The application asked its resolver once, stored the result, and keeps using it. The model takes the larger of the TTL and the application cache, adds health-check detection, and shows that window as the failover delay. Lowering the TTL alone cannot beat the application cache.",
  fix: defaults({ primaryHealthy: 1, recordTtl: 30, appCacheSeconds: 30, detectionSeconds: 10 }),
  debrief:
    "With a 30s record TTL, a 30s application cache, and 10s detection, the effective window is 40s. That is below the 60s warning line in this model. The fix is not only a smaller TTL: the runtime cache must be bounded and the health check must detect the failure. Lowering TTL also raises query volume, so use the longest value that still meets the recovery objective.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Domain Name System (DNS) maps a name to an address. A record's time to live (TTL) is the time a recursive resolver may cache that answer. Route 53 returns the TTL with the record; the resolver decides when to ask again. When a region fails, changing the record does not reach clients that already have a cached answer.",
  },
  {
    type: "p",
    text: "Failover time is therefore a chain: detect the failure, change the answer, wait for resolver caches to expire, and wait for clients to look up again. Applications add another cache. A Java Virtual Machine (JVM) can cache a successful lookup for an implementation-specific period; networkaddress.cache.ttl sets a different value, and -1 means cache forever. The record TTL does not override that cache.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, recursive resolver, Route 53 authoritative name server, and then the regional endpoint. Route 53 is authoritative for the zone. The resolver is usually the internet service provider or corporate DNS server. The client runtime sits behind the resolver and may keep its own copy. An Anycast address or a global accelerator in front of the endpoints may fail over without waiting for DNS, which is the alternative this module compares against.",
  },
  {
    type: "compare",
    leftTitle: "DNS failover",
    rightTitle: "Address that fails over without DNS",
    rows: [
      { label: "What changes", left: "The record value and its TTL", right: "The health-checked endpoint behind a fixed address" },
      { label: "Client behavior", left: "Must re-resolve and honor the new answer", right: "Keeps the same address; new connections reach a healthy endpoint" },
      { label: "Main delay", left: "Health detection plus resolver and application cache", right: "Health detection and new-connection routing" },
      { label: "Failure mode", left: "Stale cache outlives the incident", right: "The fixed entry point becomes another dependency" },
    ],
  },
  {
    type: "table",
    headers: ["Layer", "Who caches", "What bounds it"],
    rows: [
      ["Authoritative answer", "Route 53", "The record and health-check state"],
      ["Recursive resolver", "ISP or corporate resolver", "The record TTL"],
      ["Application runtime", "JVM, connection pool, custom client", "Runtime setting or application logic"],
      ["Open connection", "Client and server", "Connection lifetime, keep-alive, and drain behavior"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A primary region failure with clients still resolving to it.",
      "The effective cache window, the failover delay remaining, and the share of clients on stale answers.",
      "Secondary utilization as clients finally move.",
      "Controls for the record TTL, application cache, and health-check detection time.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Stale answers and watch the failover delay. Then apply JVM cache dominates and lower the record TTL; observe whether the delay changes. Run the experiment before reading its explanation, then lower the caches and confirm the delay falls below the warning line.",
  },
  {
    type: "p",
    text: "Route 53's guidance gives 300 seconds as an example of a shorter value to set before a planned change, then increase it after the new settings are verified. The simulator's values are teaching values; the important quantity is the longest cache in the path, plus detection.",
  },
  { type: "sim", simId: "dns-ttl-failover" },
  { type: "experiment", experimentId: "predict-effective-cache" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary failed, but the authoritative record still pointed at it until the health check flipped. After that, clients with a cached answer kept using the failed region until their cache expired. The run exposed the difference between the record TTL and the application cache: lowering the TTL did nothing while the runtime held a 900s copy.",
  },
  {
    type: "p",
    text: "The failover delay was detection plus the larger of the TTL and the application cache. The secondary stayed idle during the stale window, then took the full load at its design utilization. DNS failover is a cache-expiry process, not an instruction to clients.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route 53 query logs and resolver behavior: a falling query rate for the old answer can mean caches are still valid, not that clients moved.",
      "Health-check status and the time it took to flip, including the failure threshold and the checker locations.",
      "Application logs and connection metrics: new connections to the old region, DNS lookup counts, and cached-address warnings.",
      "Secondary-region request rate, latency, and saturation as traffic arrives late and all at once.",
      "Client errors that persist after the record changed, especially from long-lived connections and connection pools.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the record TTL with the application or runtime DNS cache before you change anything else. Then confirm the health check flipped. If both are correct, look for open connections and clients that pin an address. A DNS change cannot repair a client that never asks again.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the effective cache window: TTL, application cache, and any connection pinning.",
      "Lower the TTL before the change and wait at least the old TTL so old answers expire.",
      "Set the runtime cache explicitly, including networkaddress.cache.ttl for JVMs, and restart or roll the fleet if the setting is read at startup.",
      "Tune health-check interval and failure threshold so detection fits the recovery objective without flapping.",
      "Drain the failed region and make clients reconnect; DNS does not close existing TCP connections.",
      "If DNS cannot meet the objective, move the entry point to an Anycast or Global Accelerator address with health-checked endpoints.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A low TTL shortens failover but increases query volume and can raise resolution latency and cost.",
      "A high TTL reduces queries and cost but makes every planned or unplanned move slower.",
      "Application caches protect against resolver latency but add a failure mode that the DNS record cannot control.",
      "Anycast or a global accelerator removes DNS from the failover path, but adds a managed dependency and its own health-check behavior.",
      "Aggressive health checks detect faster but can fail over on a transient blip; test the threshold against real failure patterns.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stale-after-ttl",
    question:
      "The record TTL is 60 seconds, but clients kept hitting the failed region for 12 minutes. How do you explain that?",
    difficulty: 3,
    hints: [
      "The record TTL is not the only cache.",
      "Think about the client runtime and open connections.",
    ],
    answer:
      "I would treat the TTL as one layer, not the whole path. The recursive resolver may have cached the answer for up to 60 seconds, but the application or JVM can cache a successful lookup longer; networkaddress.cache.ttl controls that, and some defaults are implementation-specific. Existing TCP connections also stay on the old address until they close or the pool is recycled. I would check the application cache setting, the DNS lookup rate after the change, and new-connection counts to the failed region. If the app cache is the bound, lowering the TTL again will not help; I need to change the runtime setting and restart or roll the fleet, or move the entry point to a fixed Anycast address that fails over without DNS.",
    followUps: [
      "How would you prove the resolver is no longer returning the old answer?",
      "What would you change if the clients are third-party and you cannot control their caches?",
      "How does connection draining change the timeline?",
    ],
    redFlags: [
      "Assumes a DNS change is pushed to every client immediately.",
      "Looks only at the record TTL.",
      "Ignores long-lived connections and connection pools.",
    ],
    rubric: [
      "Names resolver caching and application caching separately.",
      "Mentions open connections.",
      "Proposes a measurement, not only a setting change.",
      "States when DNS is the wrong tool for the RTO.",
    ],
  },
  {
    id: "design-for-rto",
    question:
      "You have a two-minute recovery objective for a regional failover. How do you design the DNS and entry-point path?",
    difficulty: 4,
    hints: [
      "Work backward from the objective.",
      "Not every failover has to wait for DNS.",
    ],
    answer:
      "I would budget the two minutes across detection, answer change, cache expiry, and client reconnect. That usually means a short TTL, a runtime DNS cache that is explicitly bounded, and health checks with a low interval and threshold that still avoid flapping. I would test with real clients and measure the tail, not the average. If the budget cannot be met, I would put a fixed Anycast address or Global Accelerator in front of health-checked regional endpoints so new connections move without waiting for DNS. I would still keep DNS for the name, but the failover would not depend on every resolver and application cache expiring. I would also plan connection draining and a rollback path.",
    followUps: [
      "What does the TTL cost you in query volume?",
      "How do you prevent flapping when detection is fast?",
      "What happens to requests already in flight during the move?",
    ],
    redFlags: [
      "Sets TTL to zero and calls it done.",
      "Ignores application caches and connection pools.",
      "Designs detection without a flapping threshold.",
    ],
    rubric: [
      "Builds a time budget.",
      "Covers resolver and application caches.",
      "Considers a non-DNS entry point.",
      "Includes testing and rollback.",
    ],
  },
  {
    id: "ttl-tradeoff",
    question:
      "Why not set every record to a 30-second TTL and remove the caching problem entirely?",
    difficulty: 2,
    hints: [
      "Every client lookup becomes a query.",
      "A short TTL still does not close open connections.",
    ],
    answer:
      "A 30-second TTL increases the query rate and the load on the authoritative service, and it can add resolution latency for clients whose resolver is far away. It also costs more at scale because DNS queries are billed. More importantly, it does not fix the application cache or an open connection, so the failover can still exceed the objective. I would use a short TTL only where the recovery objective justifies it, keep longer TTLs for stable records, and control the application cache separately. I would also test the resolver and client behavior instead of assuming every cache honors the value the same way.",
    followUps: [
      "How would you decide which records deserve a short TTL?",
      "What does a resolver do when its upstream is slow?",
      "How do you keep the query increase from becoming its own incident?",
    ],
    redFlags: [
      "Sets every record to the minimum without a cost or load estimate.",
      "Assumes TTL controls the application cache.",
      "Ignores open connections.",
    ],
    rubric: [
      "Names query volume and cost.",
      "Separates resolver and application caching.",
      "Scopes short TTLs to the records that need them.",
      "Includes a test or measurement.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document the record TTL, the application DNS cache, and the connection lifetime for each client type.",
      "Alert on health-check status and on new connections to a region that should be drained.",
      "Lower TTLs before planned changes and wait at least the old TTL.",
      "Test failover from a real client network, not only with a resolver query.",
      "Decide whether the recovery objective needs an Anycast or global-accelerator entry point.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the health check is unhealthy before blaming DNS.",
      "Compare the stale-client share with the TTL and application cache.",
      "Drain the failed region and force connection pools to reconnect.",
      "Watch the secondary for a late, concentrated load spike.",
      "Record the time of the record change and the first successful new answer.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore the normal TTL deliberately; do not leave a temporary low value unowned.",
      "Verify query volume, resolution latency, and cost after the change.",
      "Update the runbook with the measured failover time and the binding cache.",
      "Add a failover test that exercises the application runtime, not only DNS.",
    ],
  },
];

const references = [
  {
    title: "Values specific for simple records: TTL",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-values-basic.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Route 53 defines TTL as the time recursive resolvers may cache a record and recommends a shorter value before a change.",
  },
  {
    title: "How internet traffic is routed to your website or web application",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/welcome-dns-service.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The resolver path, caching, and the difference between authoritative and recursive answers.",
  },
  {
    title: "Java InetAddress: InetAddress caching",
    url: "https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/net/InetAddress.html",
    publisher: "Oracle",
    kind: "docs" as const,
    note: "networkaddress.cache.ttl, implementation-specific positive caching, and the cache-forever value.",
  },
  {
    title: "RFC 1034: Domain names - concepts and facilities",
    url: "https://www.rfc-editor.org/rfc/rfc1034.html",
    publisher: "IETF",
    kind: "standard" as const,
    note: "The DNS cache and time-to-live model that resolver behavior is built on.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "dns-ttl-failover": {
      model: dnsTtlFailoverModel,
      presets,
      instructions:
        "Start Healthy, then apply Stale answers. Compare the failover delay with the record TTL. Apply JVM cache dominates and change the TTL: the delay should not move until the application cache is reduced.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The record TTL is the resolver cache bound; the application cache is a separate bound. Detection time is a teaching value, not a Route 53 guarantee. The secondary is assumed to be sized for full production traffic at about 70% utilization.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-timeouts",
    "traffic-route53-health-checks",
    "traffic-global-accelerator",
    "reliability-dns-failure",
  ],
};
