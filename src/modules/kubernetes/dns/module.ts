import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DOTS_IN_NAME = 2;
const CLUSTER_DNS_QPS = 20_000;

const params: ParamSpec[] = [
  {
    id: "qps",
    label: "Lookups per second",
    min: 100,
    max: 8_000,
    step: 100,
    value: 1_000,
    unit: " qps",
    group: "Traffic",
    help: "Application lookups per second. Each lookup may become several DNS queries after the search path is applied.",
    format: "rps",
  },
  {
    id: "ndots",
    label: "ndots",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: "",
    group: "Resolver",
    help: "A name with fewer dots than this is tried against the search domains before the absolute name. Kubernetes sets 5 by default in the pod resolv.conf.",
    format: "count",
  },
  {
    id: "searchPaths",
    label: "Search paths",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: " paths",
    group: "Resolver",
    help: "Suffixes appended to a short name, in order. Each failed suffix produces another query before the absolute name is tried.",
    format: "count",
  },
  {
    id: "cacheHit",
    label: "CoreDNS cache hit",
    min: 0,
    max: 95,
    step: 5,
    value: 80,
    unit: "%",
    group: "CoreDNS",
    help: "Share of queries answered from the CoreDNS cache. A higher hit rate lowers the query load that reaches the upstream resolver.",
    format: "percent",
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
  qps: number;
  ndots: number;
  searchPaths: number;
  cacheHit: number;
  attempts: number;
  queryRate: number;
  effective: number;
  dnsUtil: number;
  upstreamUtil: number;
  p99: number;
  errors: number;
}

function compute(p: Params): Computed {
  const qps = Math.round(clamp(num(p, "qps", 1_000), 100, 8_000));
  const ndots = Math.round(clamp(num(p, "ndots", 2), 1, 5));
  const searchPaths = Math.round(clamp(num(p, "searchPaths", 2), 1, 4));
  const cacheHit = Math.round(clamp(num(p, "cacheHit", 80), 0, 95));
  const attempts = DOTS_IN_NAME < ndots ? searchPaths + 1 : 1;
  const queryRate = qps * attempts;
  const effective = queryRate * (1 - cacheHit / 100);
  const dnsUtil = (queryRate / CLUSTER_DNS_QPS) * 100;
  const upstreamUtil = (effective / CLUSTER_DNS_QPS) * 100;
  const queue =
    dnsUtil <= 80 ? 2 + 8 * (dnsUtil / 100) : 2 + 6.4 + 600 * ((dnsUtil - 80) / 20) ** 2;
  return {
    qps,
    ndots,
    searchPaths,
    cacheHit,
    attempts,
    queryRate,
    effective,
    dnsUtil,
    upstreamUtil,
    p99: Math.min(30_000, attempts * (2 + queue)),
    errors: clamp((dnsUtil - 90) * 0.6, 0, 50),
  };
}

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(values: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return values.reduce<Health>((best, value) => (rank[value] > rank[best] ? value : best), "ok");
}

function buildFrame(values: Computed, seed: number, p99: number): SimFrame {
  const dnsHealth = healthFor(values.dnsUtil, 70, 90);
  const upstreamHealth = healthFor(values.upstreamUtil, 70, 90);
  const errorHealth = healthFor(values.errors, 0.5, 2);
  const latencyHealth = healthFor(p99, 100, 300);
  const appHealth = worst([errorHealth, latencyHealth]);
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Client",
      kind: "client",
      health: "ok",
      sublabel: "calls the Service name",
      meta: { view: "flow" },
    },
    {
      id: "app",
      label: "checkout pod",
      kind: "service",
      health: appHealth,
      sublabel: `${values.qps.toLocaleString()} lookups/s · ${values.errors.toFixed(1)}% failed`,
      detail: `The application asks for a name, not an IP. If the resolver takes seconds, the request looks like an application timeout because the socket has not been opened yet.`,
      meta: { view: "flow" },
    },
    {
      id: "config",
      label: "resolv.conf",
      kind: "service",
      health: values.attempts > 1 ? "warn" : "ok",
      sublabel: `ndots:${values.ndots} · ${values.searchPaths} search paths`,
      detail: `A name with ${DOTS_IN_NAME} dots is tried against ${values.attempts === 1 ? "the absolute name first" : `${values.attempts} forms because ${DOTS_IN_NAME} is below ndots:${values.ndots}`}. The trailing dot form skips the search list.`,
      meta: { view: "flow" },
    },
    {
      id: "coredns",
      label: "CoreDNS",
      kind: "dns",
      health: dnsHealth,
      utilization: clamp(values.dnsUtil / 100),
      throughput: values.queryRate,
      capacity: CLUSTER_DNS_QPS,
      sublabel: `2 replicas · ${Math.round(values.queryRate).toLocaleString()} qps`,
      detail: `Two replicas with an illustrative combined capacity of ${CLUSTER_DNS_QPS.toLocaleString()} queries/s. Cache hits are ${values.cacheHit}%; ${Math.round(values.effective).toLocaleString()} misses/s reach the upstream resolver.`,
      meta: { view: "flow" },
    },
    {
      id: "upstream",
      label: "Upstream resolver",
      kind: "external",
      health: upstreamHealth,
      utilization: clamp(values.upstreamUtil / 100),
      throughput: values.effective,
      sublabel: `${Math.round(values.effective).toLocaleString()} qps · cache misses`,
      detail: "Queries that CoreDNS cannot answer from cache are forwarded here. Search-path expansion multiplies the traffic that reaches this hop.",
      meta: { view: "flow" },
    },
  ];
  return {
    t: 0,
    nodes,
    edges: [
      edge("client-app", "client", "app", 0.9),
      edge("app-config", "app", "config", 0.4, values.attempts > 1 ? "warn" : "ok"),
      edge("app-coredns", "app", "coredns", clamp(values.dnsUtil / 100), dnsHealth),
      edge("coredns-upstream", "coredns", "upstream", clamp(values.upstreamUtil / 100), upstreamHealth),
    ],
    metrics: [
      metric("dns-p99", "DNS p99", p99, "ms", 100, 300, "ms"),
      metric("query-load", "CoreDNS utilization", values.dnsUtil, "%", 70, 90, "percent"),
      metric("upstream-load", "Upstream utilization", values.upstreamUtil, "%", undefined, undefined, "percent"),
      metric("servfail", "Failed lookups", values.errors, "%", 0.5, 2, "percent"),
      metric("query-rate", "Effective DNS queries", values.effective, " qps", undefined, undefined, "rps"),
      metric("attempts", "Queries per lookup", values.attempts, "", undefined, undefined, "count"),
      metric("cache-hit", "CoreDNS cache hit", values.cacheHit, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, ndots: values.ndots, attempts: values.attempts },
    summary: `${values.qps.toLocaleString()} lookups/s become ${Math.round(values.queryRate).toLocaleString()} raw queries/s; ${Math.round(values.effective).toLocaleString()} reach upstream after cache. CoreDNS at ${values.dnsUtil.toFixed(0)}%, p99 ${p99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.6);
  const entries: [string, number, number][] = [
    ["dns-p99", values.p99, 2],
    ["query-load", values.dnsUtil, 0.3],
    ["upstream-load", values.upstreamUtil, 0.2],
    ["servfail", values.errors, 0.05],
    ["query-rate", values.effective, 5],
    ["attempts", values.attempts, 0],
    ["cache-hit", values.cacheHit, 0.2],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "dns-p99",
    metricId: "dns-p99",
    warn: 100,
    crit: 300,
    title: "Name resolution is adding seconds to the request",
    cause:
      "CoreDNS is queueing queries, or the search path is multiplying each lookup into several serial queries. The application sees a delay before it can open a connection, so the symptom looks like application latency rather than DNS.",
    fix:
      "Lower the query volume first: reduce ndots for names that do not need the cluster search list, remove unused search paths, or use an absolute name. Then check CoreDNS replicas and cache hit rate. Increasing replicas without fixing amplification hides the cost instead of removing it.",
    checkFirst: [
      "Read the pod's resolv.conf and count the search paths and ndots value.",
      "Compare application lookup rate with the query rate observed at CoreDNS.",
      "Check CoreDNS latency, cache hit rate, and replica count together.",
    ],
  },
  {
    id: "query-load",
    metricId: "query-load",
    warn: 70,
    crit: 90,
    title: "CoreDNS is carrying more queries than the workload makes",
    cause:
      "A short name below the ndots threshold is expanded into one query per search path before the absolute name is tried. The application makes one lookup; CoreDNS serves several. Low cache hit rates multiply the upstream load further.",
    fix:
      "Set ndots to a value that matches the names the application resolves, trim the search list, and use fully qualified names for external dependencies. Verify the query rate falls before adding replicas or raising cache size.",
    checkFirst: [
      "Compare the application's lookup rate with CoreDNS's query rate.",
      "Check ndots and the search list in the pod spec and the generated resolv.conf.",
      "Check the cache hit ratio and whether the same names repeat.",
    ],
  },
  {
    id: "servfail",
    metricId: "servfail",
    warn: 0.5,
    crit: 2,
    title: "Lookups are failing, not only slowing down",
    cause:
      "CoreDNS or the upstream resolver is dropping queries under load, or a search-path query returns an error that the client surfaces as a resolution failure. Established connections keep working, which is why direct pod IPs still succeed.",
    fix:
      "Check CoreDNS logs and errors, then the upstream resolver. Reduce query amplification and cache misses before scaling, and confirm that the Service name resolves from a pod in the same namespace. Keep the search path consistent across clients so the failure is reproducible.",
    checkFirst: [
      "Run a lookup from a pod and compare the Service name with a direct pod IP.",
      "Check CoreDNS logs for SERVFAIL, timeouts, and upstream errors.",
      "Check whether only short names fail while fully qualified names work.",
    ],
  },
];

function defaultsFor(id: string): Params {
  if (id === "peak") {
    return defaults({ qps: 4_000, ndots: 3, searchPaths: 3, cacheHit: 60 });
  }
  if (id === "failure") {
    return defaults({ qps: 6_000, ndots: 5, searchPaths: 4, cacheHit: 40 });
  }
  if (id === "ndots-fixed") {
    return defaults({ qps: 4_000, ndots: 1, searchPaths: 3, cacheHit: 60 });
  }
  if (id === "recovery") {
    return defaults({ qps: 6_000, ndots: 2, searchPaths: 2, cacheHit: 80 });
  }
  return defaults();
}

export const dnsModel: SimModel = {
  id: "kubernetes-dns",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed, values.p99);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const sampledP99 = Math.max(1, values.p99 * (1 + rng.between(-0.01, 0.01)));
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), sampledP99);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.summary = `${values.qps.toLocaleString()} lookups/s become ${Math.round(values.queryRate).toLocaleString()} raw queries/s; ${Math.round(values.effective).toLocaleString()} reach upstream after cache. CoreDNS at ${values.dnsUtil.toFixed(0)}%, p99 ${sampledP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.qps.toLocaleString()} application lookups/s become ${values.queryRate.toLocaleString()} raw DNS queries/s because each lookup takes ${values.attempts} attempt${values.attempts === 1 ? "" : "s"} through the search path.`,
      `CoreDNS handles the raw query rate. After ${values.cacheHit}% cache hits, ${Math.round(values.effective).toLocaleString()} queries/s reach the upstream resolver. CoreDNS is at ${values.dnsUtil.toFixed(0)}%; upstream is at ${values.upstreamUtil.toFixed(0)}%.`,
      values.attempts > 1
        ? `The name has ${DOTS_IN_NAME} dots and ndots is ${values.ndots}. The resolver tries ${values.searchPaths} search suffixes before the absolute name, so a single lookup is not a single query.`
        : "The name is resolved as an absolute name first, so the search path does not multiply the query.",
      values.dnsUtil >= 90
        ? "CoreDNS is saturated. Fix the amplification and cache hit rate before adding replicas; the same workload will follow the new replicas."
        : values.upstreamUtil >= 90
          ? "CoreDNS has headroom but the upstream resolver is saturated. Reduce cache misses or add upstream capacity."
          : "CoreDNS and the upstream resolver are within capacity. If latency is still high, check the number of serial attempts.",
    ];
  },
  legend: [
    { label: "Resolving normally", tone: "ok" },
    { label: "Search-path expansion", tone: "warn" },
    { label: "DNS saturated or failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Short search list, warm cache, and CoreDNS far below capacity.",
    tone: "ok",
    params: defaultsFor("healthy"),
  },
  {
    id: "peak",
    label: "Search-path tax",
    description: "A larger search list multiplies lookups and pushes CoreDNS into its warning band.",
    tone: "warn",
    params: defaultsFor("peak"),
  },
  {
    id: "failure",
    label: "Amplified lookups",
    description: "ndots 5 and four search paths turn 6,000 lookups into 30,000 queries.",
    tone: "crit",
    params: defaultsFor("failure"),
  },
  {
    id: "ndots-fixed",
    label: "ndots lowered",
    description: "The same traffic resolves as absolute names first; query volume collapses.",
    tone: "ok",
    params: defaultsFor("ndots-fixed"),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The resolver configuration is fixed and the cache is warm; DNS returns to normal.",
    tone: "ok",
    params: defaultsFor("recovery"),
  },
];

const experiment: Experiment = {
  id: "predict-amplification",
  title: "Predict why DNS fails when the application rate looks modest",
  simId: "dns",
  question:
    "The application makes 6,000 lookups per second, but CoreDNS receives 30,000 queries per second. What is the most likely cause?",
  prediction: {
    options: [
      { id: "wrong", label: "The Service name is misspelled and every lookup fails" },
      { id: "amplify", label: "ndots and the search path expand each lookup into several queries" },
      { id: "replicas", label: "CoreDNS has too few replicas for any query rate" },
      { id: "cache", label: "The cache is too small to hold the records" },
    ],
    correctOptionId: "amplify",
    explanation:
      "A name with fewer dots than ndots is tried against each search suffix before the absolute name. With four search paths, one application lookup becomes five DNS queries. The application rate is not the query rate. Cache hits reduce upstream traffic but do not remove the initial expansion.",
  },
  setup: defaults({ qps: 6_000, ndots: 5, searchPaths: 4, cacheHit: 40 }),
  runFor: 20,
  observe: [
    "The raw query rate is five times the application lookup rate: 30,000 per second.",
    "After 40% cache hits, 18,000 queries per second reach upstream, still three times the lookup rate.",
    "CoreDNS utilization passes 100% and p99 reaches the model's ceiling.",
    "Lookups fail while direct pod IPs continue to work.",
    "Lowering ndots removes the amplification without adding a replica.",
  ],
  explain:
    "The resolver is doing what resolv.conf tells it to do. A short name is not treated as absolute when ndots is high; it is tried with each search suffix in order. Each attempt is a real query with its own latency and cache lookup. Under load those attempts queue at CoreDNS, and the application experiences a timeout before it ever connects. The fix belongs in the resolver configuration or in the names the application uses, not only in the CoreDNS replica count.",
  fix: defaults({ qps: 6_000, ndots: 2, searchPaths: 2, cacheHit: 80 }),
  debrief:
    "Fixing ndots and the search list collapses the raw query rate back to the application lookup rate, and a warmer cache leaves only a small share for the upstream resolver. The same traffic now fits comfortably in two replicas. DNS capacity was real, but the workload was asking CoreDNS for five times more queries than the application made, and the cache still passed three times the lookup rate upstream.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cluster DNS turns a Service name into an address. CoreDNS runs as a Deployment in the cluster, usually with two replicas, and is exposed through a Service. Pods get a resolv.conf with nameserver entries pointing at the cluster DNS Service, a search list of cluster suffixes, and an ndots value. Those three settings decide how a name is resolved and how many queries one application lookup produces.",
  },
  {
    type: "p",
    text: "ndots is a threshold, not a dot count. If a name contains fewer dots than ndots, the resolver tries the search domains first; if it contains at least ndots dots, it tries the absolute name first. Kubernetes commonly writes ndots:5 into the pod resolv.conf. A short Service name with one or two dots is therefore tried against namespace and cluster suffixes before the absolute name. A trailing dot marks a name as absolute and skips the search list.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "DNS sits below service discovery and above the application's connection setup. A Service provides a stable virtual IP; a headless Service returns the endpoint addresses directly. The application resolves the name, then opens a connection to the result. If resolution is slow, the request has not reached the Service yet, so Service metrics and application traces can both look healthy while the client waits. Direct pod IPs work because they bypass the resolver.",
  },
  {
    type: "table",
    headers: ["Record or setting", "What it does", "Failure it can cause"],
    rows: [
      ["ClusterIP Service", "Returns one virtual IP for the Service", "Works, but hides which pod is selected"],
      ["Headless Service", "Returns endpoint addresses directly", "Clients need endpoint-aware behavior"],
      ["ndots", "Chooses search-first or absolute-first", "Extra queries for short names"],
      ["Search path", "Appends cluster suffixes in order", "Multiply attempts and latency"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Application lookup",
    rightTitle: "DNS query",
    rows: [
      { label: "Unit", left: "One name the app asks for", right: "One packet to a resolver" },
      { label: "Count", left: "The rate the app reports", right: "The rate CoreDNS serves" },
      { label: "Multiplier", left: "One", right: "Search paths plus the absolute attempt" },
      { label: "Symptom", left: "Connect timeout", right: "CoreDNS saturation or SERVFAIL" },
    ],
  },
  {
    type: "p",
    text: "This module models a name with two dots, an ndots setting from one to five, up to four search paths, and two CoreDNS replicas with an illustrative combined capacity of 20,000 queries per second. The values are teaching numbers. The causal chain is the lesson: one lookup can become several queries before a packet leaves the pod.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Application lookups per second beside the raw query rate and the cache-miss rate that reaches upstream.",
      "Queries per lookup, derived from ndots and the search-path count.",
      "CoreDNS utilization, cache hit rate, DNS p99, and failed lookups.",
      "The resolv.conf node, which marks search-path expansion even when capacity is still available.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that one lookup equals one query. Apply Search-path tax: the query rate rises before CoreDNS saturates. Apply Amplified lookups and compare the lookup rate with the query rate, then apply ndots lowered. Run the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "dns" },
  {
    type: "p",
    text: "The first split in a DNS incident is between resolution and routing. If the Service name fails but a direct pod IP works, the request path never reached the Service. Read resolv.conf, count the search paths, and compare the application lookup rate with the query rate at CoreDNS. A resolver timeout is not an application timeout even when the user sees the same error.",
  },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The application made 6,000 lookups per second, but each name had two dots and ndots was five, so the resolver tried four search suffixes before the absolute name. CoreDNS saw 30,000 queries per second before the cache. The cache absorbed part of it, not enough. CoreDNS queued, p99 rose to the model's ceiling, and lookups failed. The application reported timeouts; the Service and the pods were healthy.",
  },
  {
    type: "p",
    text: "Lowering ndots to two removed the search-path expansion for this name. The raw query rate fell to the lookup rate, and the cache cut the upstream share further. Adding replicas would also have relieved the symptom, but it would have paid for five times the queries the workload needed.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CoreDNS metrics: request rate, response code, cache hits and misses, and latency by query type.",
      "Pod resolv.conf: nameserver, search list, ndots, and timeout options.",
      "Application errors that begin before a connection is established, with no server-side request log.",
      "Node-local DNS cache behavior, which can shift the load and hide the upstream rate.",
      "A comparison of a Service name lookup with a direct pod IP connection from the same pod.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read resolv.conf and count the search paths. Compare the application lookup rate with the CoreDNS query rate. If the second number is a multiple of the first, fix the resolver configuration or use absolute names before adding DNS capacity. Then check cache hit rate and replica count.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the failure is resolution: Service name fails, direct pod IP works.",
      "Read ndots and the search list from the failing pod.",
      "Reduce ndots or the search list for workloads that resolve external names, or use a trailing dot.",
      "Verify the raw query rate falls at CoreDNS.",
      "Raise cache hit rate and CoreDNS replicas only after the amplification is removed.",
      "Retest from the same pod and compare the Service name with a fully qualified name.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Lowering ndots speeds external names but can change how short cluster names resolve.",
      "A larger search list helps local names but multiplies queries for names outside the cluster.",
      "More CoreDNS replicas add capacity but also add cost and do not reduce amplification.",
      "A longer cache TTL reduces load but can serve stale records after an endpoint change.",
      "A headless Service gives clients endpoint addresses but moves load-balancing work into the client.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "service-name-fails",
    question:
      "A Service name fails intermittently, but connecting to a pod IP works. How do you split the problem?",
    difficulty: 2,
    hints: [
      "Service name resolution and Service routing are different layers.",
      "Direct pod IP success proves the network path, not DNS.",
    ],
    answer:
      "I treat it as a resolution problem first because the name fails while the IP works. I read the pod's resolv.conf, check ndots and the search list, and compare the application lookup rate with the CoreDNS query rate. I also run a lookup from the same pod for the Service name and for a fully qualified name. If the name resolves but the connection fails, I move to endpoints and kube-proxy. If the query rate is a multiple of the lookup rate, the search path is the first suspect.",
    followUps: [
      "What would make only one namespace fail?",
      "How does a headless Service change the answer?",
      "What does a trailing dot do?",
    ],
    redFlags: [
      "Blaming the application without checking resolv.conf.",
      "Scaling CoreDNS before measuring query amplification.",
      "Confusing DNS with Service routing.",
    ],
    rubric: [
      "Separates resolution from routing.",
      "Reads resolv.conf.",
      "Compares lookup and query rates.",
      "Names a next layer if resolution succeeds.",
    ],
  },
  {
    id: "ndots",
    question:
      "Explain ndots to someone who thinks it means the resolver tries five times.",
    difficulty: 2,
    hints: [
      "It is a threshold compared with the number of dots in the name.",
      "The search list supplies the extra attempts.",
    ],
    answer:
      "ndots is compared with the number of dots in the name. If the name has fewer dots than ndots, the resolver tries the name with each search suffix before trying the absolute name. If the name has at least ndots dots, it tries the absolute name first. The number of attempts depends on the search list, not on ndots itself. A name with two dots and ndots five can produce one query per search suffix plus the absolute query. A trailing dot makes the name absolute and skips the search list.",
    followUps: [
      "What is the default in a Kubernetes pod?",
      "When would you raise ndots?",
      "How does the search list order affect latency?",
    ],
    redFlags: [
      "Treats ndots as an attempt count.",
      "Forgets the absolute attempt.",
      "Ignores the search list.",
    ],
    rubric: [
      "Defines ndots as a threshold.",
      "Explains search-first behavior.",
      "Connects attempts to search paths.",
      "Mentions the absolute name.",
    ],
  },
  {
    id: "coredns-saturated",
    question:
      "CoreDNS is at 95% utilization. Do you add replicas or change the clients?",
    difficulty: 3,
    hints: [
      "First find out whether the query rate is legitimate.",
      "Adding replicas is a valid mitigation but not a diagnosis.",
    ],
    answer:
      "I first compare the application lookup rate with the CoreDNS query rate and check the cache hit ratio. If the query rate is inflated by search-path expansion, I fix ndots or the search list and use absolute names for external dependencies. That removes load permanently and reduces cost. If the query rate is legitimate, I add replicas and check the upstream resolver, because more replicas can move the bottleneck downstream. During an active incident I might add a replica as a temporary mitigation while I fix the amplification, but I would not stop at the replica count.",
    followUps: [
      "How would you prove the query rate is inflated?",
      "What is the risk of a larger cache?",
      "How does a node-local cache change the plan?",
    ],
    redFlags: [
      "Adds replicas without measuring the query rate.",
      "Ignores the upstream resolver.",
      "Changes ndots without checking cluster name resolution.",
    ],
    rubric: [
      "Measures amplification first.",
      "Checks cache and upstream.",
      "Treats replicas as mitigation.",
      "Validates the fix at the client.",
    ],
  },
  {
    id: "headless",
    question:
      "Why does a StatefulSet usually need a headless Service, and what does DNS return for it?",
    difficulty: 3,
    hints: [
      "StatefulSet pods have stable ordinal names.",
      "A headless Service has no virtual IP.",
    ],
    answer:
      "A headless Service sets clusterIP to None. DNS returns the addresses of the selected endpoints instead of one virtual IP, and each pod gets a stable DNS name based on its ordinal and the Service. That gives a StatefulSet member a predictable identity for peers, replication, and leader discovery. The tradeoff is that the client receives multiple addresses and must decide how to use them; there is no kube-proxy virtual IP doing per-connection load balancing. Readiness still controls which endpoints appear.",
    followUps: [
      "What happens when a pod is not ready?",
      "How would a client discover the primary?",
      "What does the stable pod name look like?",
    ],
    redFlags: [
      "Says a headless Service returns a virtual IP.",
      "Ignores readiness and endpoints.",
      "Assumes DNS performs leader election.",
    ],
    rubric: [
      "Explains clusterIP None.",
      "Connects ordinal identity to DNS.",
      "Mentions endpoint readiness.",
      "Notes client-side behavior.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Workloads that resolve external names have an ndots value that matches those names.",
      "The search list contains only suffixes the workload needs.",
      "CoreDNS replicas, cache, and upstream capacity are sized from a measured query rate.",
      "A DNS lookup from a pod is part of the service smoke test.",
      "Dashboards show CoreDNS query rate and latency beside application lookup errors.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split resolution from routing with a Service name and a direct pod IP test.",
      "Read resolv.conf and count the search paths before changing CoreDNS.",
      "Compare the application lookup rate with the CoreDNS query rate.",
      "Check cache hit rate, SERVFAIL, and upstream resolver health.",
      "Record whether the fix reduced query volume or only added capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Keep the resolver change that removed amplification, or document why it was reverted.",
      "Add a load test that exercises name resolution at the real lookup rate.",
      "Alert on CoreDNS saturation and failed lookups, not only on pod restarts.",
      "Review headless Service consumers for endpoint and readiness handling.",
    ],
  },
];

const references = [
  {
    title: "DNS for Services and Pods",
    url: "https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Service DNS names, pod DNS policy, and resolv.conf options.",
  },
  {
    title: "Debugging DNS Resolution",
    url: "https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "A pod-based workflow for testing cluster name resolution.",
  },
  {
    title: "CoreDNS Manual",
    url: "https://coredns.io/manual/toc/",
    publisher: "CoreDNS",
    kind: "docs" as const,
    note: "Corefile configuration, caching, and forwarding behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    dns: {
      model: dnsModel,
      presets,
      instructions:
        "Start Healthy, then apply Search-path tax. Compare application lookups with effective queries. Apply Amplified lookups, then ndots lowered, before you try Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. The CoreDNS capacity and lookup sizes are teaching values, not a benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-services-networking",
    "traffic-dns-ttl-failover",
    "case-composite-k8s-dns",
    "kubernetes-statefulsets",
  ],
};
