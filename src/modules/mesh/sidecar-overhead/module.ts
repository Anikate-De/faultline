import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PODS = 4;
const CPU_MILLICORES_PER_KRPS_PER_HOP = 70;
const APP_TIMEOUT_MS = 500;

const params = [
  {
    id: "requestRate",
    label: "Service request rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second across four service pods. Per-pod rate is this value divided by four.",
    format: "rps" as const,
  },
  {
    id: "meshHops",
    label: "Sidecar hops per request",
    min: 0,
    max: 4,
    step: 1,
    value: 2,
    unit: " hops",
    group: "Mesh",
    help: "Proxy hops on the request path. Zero is the no-mesh baseline; each hop adds CPU and a small latency cost.",
    format: "count" as const,
  },
  {
    id: "cpuLimit",
    label: "Sidecar CPU limit",
    min: 50,
    max: 1_000,
    step: 25,
    value: 200,
    unit: " m",
    group: "Resources",
    help: "CPU limit per sidecar container in millicores. Demand above the limit is throttled by the kernel.",
    format: "count" as const,
  },
  {
    id: "connectionPool",
    label: "Upstream pool per sidecar",
    min: 16,
    max: 512,
    step: 16,
    value: 256,
    unit: " conns",
    group: "Resources",
    help: "Maximum concurrent upstream connections per sidecar. High concurrency or slow responses queue here.",
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
  hops: number;
  perPodRps: number;
  cpuLimit: number;
  connectionPool: number;
  cpuDemand: number;
  cpuUtil: number;
  throttledPct: number;
  concurrency: number;
  poolUtil: number;
  p99: number;
  overhead: number;
  timeoutPct: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 4_000));
  const hops = Math.round(clamp(num(p, "meshHops", 2), 0, 4));
  const cpuLimit = Math.max(1, num(p, "cpuLimit", 200));
  const pool = Math.max(1, num(p, "connectionPool", 256));
  const perPodRps = requestRate / PODS;
  const cpuDemand = hops === 0 ? 0 : (perPodRps / 1_000) * CPU_MILLICORES_PER_KRPS_PER_HOP * hops;
  const cpuUtil = hops === 0 ? 0 : (cpuDemand / cpuLimit) * 100;
  const throttledPct = cpuUtil > 100 ? (1 - cpuLimit / cpuDemand) * 100 : 0;
  const concurrency = hops === 0 ? 0 : perPodRps * (0.004 + hops * 0.002);
  const poolUtil = hops === 0 ? 0 : (concurrency / pool) * 100;
  const p99 =
    hops === 0
      ? 18
      : Math.min(
          5_000,
          18 + hops * 2.4 + Math.max(0, cpuUtil - 100) * 4.5 + Math.max(0, poolUtil - 70) * 1.2,
        );
  const timeoutPct = p99 > APP_TIMEOUT_MS ? Math.min(25, (p99 - APP_TIMEOUT_MS) / 80) : 0;
  return {
    requestRate,
    hops,
    perPodRps,
    cpuLimit,
    connectionPool: pool,
    cpuDemand,
    cpuUtil,
    throttledPct,
    concurrency,
    poolUtil,
    p99,
    overhead: p99 - 18,
    timeoutPct,
  };
}

function healthFor(errors: number): SimState {
  if (errors >= 2) return "crit";
  if (errors >= 0.5) return "warn";
  return "ok";
}

function sidecarHealth(c: Computed): SimState {
  if (c.hops === 0) return "ok";
  if (c.cpuUtil >= 90 || c.throttledPct >= 25) return "crit";
  if (c.cpuUtil >= 75 || c.throttledPct >= 5) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const sidecar = sidecarHealth(c);
  const app = healthFor(c.timeoutPct);
  const bypass = c.hops === 0;
  const sidecarSublabel = bypass
    ? "bypassed"
    : `${Math.round(c.cpuUtil)}% of limit · ${Math.round(c.throttledPct)}% throttled`;
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: "ok",
        utilization: clamp(c.requestRate / 20_000),
        throughput: c.requestRate,
        sublabel: `${c.requestRate.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "ingress-sidecar",
        label: "Ingress sidecar",
        kind: "mesh",
        health: sidecar,
        utilization: clamp(c.cpuUtil / 100),
        throughput: c.requestRate,
        sublabel: sidecarSublabel,
        detail: `Illustrative model: ${Math.round(c.cpuDemand)}m CPU demand against a ${Math.round(c.cpuLimit)}m limit, per pod.`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout app",
        kind: "service",
        health: app,
        utilization: clamp(c.timeoutPct / 20),
        throughput: c.requestRate,
        sublabel: `${c.timeoutPct.toFixed(1)}% timeouts`,
        meta: { view: "flow" },
      },
      {
        id: "egress-sidecar",
        label: "Egress sidecar",
        kind: "mesh",
        health: sidecar,
        utilization: clamp(c.poolUtil / 100),
        throughput: c.requestRate,
        sublabel: bypass ? "bypassed" : `${Math.round(c.poolUtil)}% pool use`,
        meta: { view: "flow" },
      },
      {
        id: "inventory",
        label: "Inventory service",
        kind: "service",
        health: app,
        utilization: clamp(c.timeoutPct / 20),
        throughput: c.requestRate,
        sublabel: "upstream",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-ingress", "clients", "ingress-sidecar", 0.7, sidecar),
      edge("ingress-checkout", "ingress-sidecar", "checkout", 0.7, app),
      edge("checkout-egress", "checkout", "egress-sidecar", 0.7, sidecar),
      edge("egress-inventory", "egress-sidecar", "inventory", 0.7, app),
    ],
    metrics: [
      metric("p99", "End-to-end p99", c.p99, "ms", 150, 500, "ms"),
      metric("cpu-util", "Sidecar CPU demand", c.cpuUtil, "%", 75, 90, "percent"),
      metric("throttled", "CPU throttled", c.throttledPct, "%", 5, 25, "percent"),
      metric("pool-util", "Upstream pool use", c.poolUtil, "%", 75, 95, "percent"),
      metric("timeout", "Application timeouts", c.timeoutPct, "%", 0.5, 2, "percent"),
      metric("overhead", "Mesh p99 overhead", c.overhead, "ms", 20, 80, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      hops: c.hops,
      cpu: c.cpuUtil,
      throttled: c.throttledPct,
    },
    summary: `p99 ${c.p99.toFixed(1)}ms with ${c.hops} sidecar hops. Per-sidecar CPU demand ${Math.round(c.cpuUtil)}% of limit, throttled ${Math.round(c.throttledPct)}%, pool ${Math.round(c.poolUtil)}%.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`The no-mesh baseline is 18ms in this model. Current p99 is ${c.p99.toFixed(1)}ms, so mesh overhead is ${c.overhead.toFixed(1)}ms across ${c.hops} hops.`);
  items.push(`Each sidecar handles about ${Math.round(c.perPodRps).toLocaleString()} rps. At ${CPU_MILLICORES_PER_KRPS_PER_HOP}m per 1,000 rps per hop, CPU demand is ${Math.round(c.cpuDemand)}m against a ${Math.round(c.cpuLimit)}m limit.`);
  items.push("CPU demand above the limit is throttled. A throttled proxy stops running for part of each period, so queued requests wait and the tail grows faster than the average.");
  items.push(`Connection concurrency is about ${c.concurrency.toFixed(1)} per sidecar. The pool allows ${Math.round(c.connectionPool)}; utilization is ${Math.round(c.poolUtil)}%.`);
  items.push("Memory is a limit and OOM risk, not a per-request latency cost. Size it for connections, buffers, and config, then watch working set.");
  items.push("Measure the same load with and without the mesh, then subtract. A rising p99 with flat CPU points at the pool; rising throttling points at the CPU limit.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 150,
    crit: 500,
    title: "End-to-end p99 breached the latency budget",
    cause: "Mesh overhead is not only the per-hop average. CPU throttling and pool queueing add tail time that a mean or p50 will miss.",
    fix: "Compare p99 with and without the mesh. If CPU is throttled, raise the limit or reduce per-pod rate. If the pool queues, raise the pool or reduce concurrency.",
    checkFirst: [
      "Measure the same request with and without sidecars.",
      "Check sidecar CPU throttling and pool pending requests.",
      "Check whether the tail exists at one hop or every hop.",
    ],
  },
  {
    id: "cpu-util",
    metricId: "cpu-util",
    warn: 75,
    crit: 90,
    title: "Sidecar CPU demand exceeds its limit",
    cause: "Per-request proxy work scales with request rate and hop count. A limit sized for idle traffic runs out under production load.",
    fix: "Raise the CPU limit or add replicas to reduce per-pod rate. Verify the limit against measured demand, not a default.",
    checkFirst: [
      "Compare CPU demand per pod with the limit.",
      "Check whether request rate or hop count changed.",
      "Check whether the sidecar shares a CPU quota with the application.",
    ],
  },
  {
    id: "throttled",
    metricId: "throttled",
    warn: 5,
    crit: 25,
    title: "The sidecar is being CPU throttled",
    cause: "The cgroup limit is below demand. Throttling pauses the proxy, which adds tail latency and can cause client timeouts.",
    fix: "Raise the limit above measured demand with headroom, or reduce per-pod request rate. Check the application container for the same problem.",
    checkFirst: [
      "Check container_cpu_cfs_throttled_periods and throttled_seconds.",
      "Compare the limit with actual usage and demand.",
      "Check whether the application and sidecar share a pod CPU quota.",
    ],
  },
  {
    id: "pool-util",
    metricId: "pool-util",
    warn: 75,
    crit: 95,
    title: "The upstream connection pool is saturated",
    cause: "Concurrency exceeds the pool. Requests wait for a connection before they reach the upstream, and the wait appears as proxy latency.",
    fix: "Raise the pool, reduce concurrency, or fix the upstream latency that is holding connections open.",
    checkFirst: [
      "Check upstream_cx_active and upstream_rq_pending.",
      "Compare concurrency with the configured pool.",
      "Check upstream response time; slower responses hold connections longer.",
    ],
  },
  {
    id: "timeout",
    metricId: "timeout",
    warn: 0.5,
    crit: 2,
    title: "Application timeouts are rising",
    cause: "Mesh tail latency has crossed the application timeout. Users see failures even though the upstream is healthy.",
    fix: "Reduce the tail at the sidecar before changing the application timeout. A longer timeout hides the cost and holds resources longer.",
    checkFirst: [
      "Compare application timeout with mesh p99.",
      "Check whether timeouts are client-side or upstream.",
      "Check the slowest hop in the trace.",
    ],
  },
];

export const sidecarOverheadModel: SimModel = {
  id: "mesh-sidecar-overhead",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const c = compute(p);
    const p99 = Math.max(1, c.p99 * (1 + rng.between(-0.02, 0.02)));
    const jittered = {
      ...c,
      p99,
      overhead: p99 - 18,
      timeoutPct: p99 > APP_TIMEOUT_MS ? Math.min(25, (p99 - APP_TIMEOUT_MS) / 80) : 0,
    };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    recordSeries(next, "cpu.sidecar", c.cpuUtil);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (c.throttledPct >= 25 && frame.flags.throttleSeen !== 1) {
      pushEvent(next, {
        id: "sidecar-throttled",
        at: frame.t,
        severity: "crit",
        title: "Sidecar CPU throttling is adding tail latency",
        detail: `${Math.round(c.cpuUtil)}% CPU demand against the limit; ${Math.round(c.throttledPct)}% of periods are throttled. p99 is ${Math.round(c.p99)}ms.`,
        nodeId: "ingress-sidecar",
        metricId: "throttled",
      });
      next.flags.throttleSeen = 1;
    }
    if (c.poolUtil >= 95 && frame.flags.poolSeen !== 1) {
      pushEvent(next, {
        id: "sidecar-pool-saturated",
        at: frame.t,
        severity: "warn",
        title: "Upstream pool is queueing",
        detail: `${Math.round(c.poolUtil)}% pool use at ${c.concurrency.toFixed(1)} concurrent requests per sidecar.`,
        nodeId: "egress-sidecar",
        metricId: "pool-util",
      });
      next.flags.poolSeen = 1;
    }
    next.summary = `p99 ${jittered.p99.toFixed(1)}ms with ${c.hops} sidecar hops. Per-sidecar CPU demand ${Math.round(c.cpuUtil)}% of limit, throttled ${Math.round(c.throttledPct)}%, pool ${Math.round(c.poolUtil)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(compute(p)),
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
    description: "Four thousand rps, two hops, and a 200m limit. CPU sits below the warning line and p99 is close to the no-mesh baseline.",
    tone: "ok",
    params: defaults({ requestRate: 4_000, meshHops: 2, cpuLimit: 200, connectionPool: 256 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Nine thousand rps at two hops. The sidecar CPU limit is close to demand but has not started throttling.",
    tone: "warn",
    params: defaults({ requestRate: 9_000, meshHops: 2, cpuLimit: 375, connectionPool: 128 }),
  },
  {
    id: "failure",
    label: "Throttled",
    description: "Twelve thousand rps across three hops against a 120m limit. Throttling turns CPU contention into a latency tail.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, meshHops: 3, cpuLimit: 120, connectionPool: 32 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The limit is raised and a hop is removed. CPU, pool, and p99 return below their warning lines.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, meshHops: 1, cpuLimit: 400, connectionPool: 256 }),
  },
];

const experiment: Experiment = {
  id: "reduce-sidecar-tail",
  title: "The knob that moves the tail",
  simId: "mesh-sidecar-overhead",
  question:
    "At 12,000 rps, three mesh hops, a 120m CPU limit per sidecar, and a 32-connection pool, p99 is almost two seconds. Which change reduces p99 most?",
  prediction: {
    options: [
      { id: "timeout", label: "Raise the application timeout so the slow requests stop failing" },
      { id: "cpu", label: "Raise the sidecar CPU limit above demand so the proxy stops being throttled" },
      { id: "memory", label: "Raise the sidecar memory limit" },
      { id: "replicas", label: "Add a retry to hide the slow attempts" },
    ],
    correctOptionId: "cpu",
    explanation:
      "Per-pod CPU demand is far above the 120m limit, so the proxy is throttled most of each scheduling period. Raising the limit removes the dominant delay.",
  },
  setup: defaults({ requestRate: 12_000, meshHops: 3, cpuLimit: 120, connectionPool: 32 }),
  runFor: 30,
  observe: [
    "CPU demand is over 500% of the 120m limit, and most periods are throttled.",
    "p99 rises to about two seconds while the pool is close to its limit.",
    "Application timeouts cross 18%.",
    "Raising the CPU limit removes the throttle and drops p99 to tens of milliseconds.",
  ],
  explain:
    "Per-pod request rate is 3,000 rps. At 70m per 1,000 rps per hop over three hops, demand is 630m against a 120m limit. The proxy is throttled for most of each scheduling period, so queued requests wait. The pool also contributes, but the throttle is the dominant term. Raising the timeout only keeps failed requests around longer; memory is not the per-request cost; retries add load.",
  fix: defaults({ requestRate: 12_000, meshHops: 3, cpuLimit: 1_000, connectionPool: 128 }),
  debrief:
    "Measure the mesh with and without sidecars at the same request rate. Compute per-pod CPU demand, then set the limit above it with headroom. If throttling is still present, reduce per-pod rate by adding replicas or removing a hop. Recheck the pool after the CPU fix; the pool often looks saturated because slow responses hold connections, not because it is undersized.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A sidecar proxy adds a process and a network hop to every request. Envoy terminates the inbound connection, applies filters, opens an upstream connection, and writes the response back to the application. That work costs CPU, memory, and file descriptors, and it changes the latency distribution. The average cost is usually small; the tail is where throttling and connection pooling show up.",
  },
  {
    type: "p",
    text: "The cost is not a fixed percentage of application latency. It scales with request rate, connection concurrency, TLS handshakes, retries, and the number of hops. A sidecar sized for 2,000 rps per pod can be throttled at 6,000 even when the application container is idle. The kernel enforces the limit, pauses the proxy, and the pause becomes queueing for every request in that period.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ingress sidecar, application, egress sidecar, upstream. Each hop adds proxy CPU and a connection pool. The application sees the sum of all hops, so a 2ms proxy cost repeated across three hops is 6ms before any queueing. When the sidecar is throttled or its pool is full, the added time is not linear: requests wait for the proxy to run or for a connection to free up.",
  },
  {
    type: "compare",
    leftTitle: "Without the mesh",
    rightTitle: "With sidecars",
    rows: [
      { label: "Hops", left: "One application connection", right: "Proxy in and out on each side" },
      { label: "CPU", left: "Application container only", right: "Application plus one or more proxy containers" },
      { label: "Tail risk", left: "Application queueing", right: "Application queueing plus throttling and pool queueing" },
      { label: "Visibility", left: "Application metrics", right: "Application plus per-hop proxy metrics" },
    ],
  },
  {
    type: "p",
    text: "CPU limits are per container, and sidecars share the pod's CPU budget with the application. A limit that is too low causes CFS throttling; a limit that is too high lets the sidecar compete with the application. Envoy's own performance guidance recommends measuring throughput and latency for your configuration rather than assuming a fixed cost. TLS, large headers, and many filters move the number.",
  },
  {
    type: "p",
    text: "Connection pools bound concurrency. Envoy's circuit breakers set maximum connections and pending requests per cluster. If responses slow down, concurrency rises because each request holds a connection longer. The pool then queues, which raises latency further. Sizing the pool without fixing the slow upstream only moves the queue.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "End-to-end p99 and mesh overhead above the no-mesh baseline.",
      "Sidecar CPU utilization, CPU throttling, and upstream pool utilization.",
      "Application timeouts as the tail crosses the timeout budget.",
      "A flow view with ingress and egress sidecars that shows where the cost accumulates.",
      "A baseline at zero hops for the same request rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then set hops to zero to see the baseline. Apply Throttled and watch CPU, throttling, and p99 move together. Apply Recovery, then change one resource at a time. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Cost source", "What it affects", "Signal"],
    rows: [
      ["Proxy hop", "Added latency per request", "p99 difference with and without the mesh"],
      ["CPU limit", "Throttling and tail queueing", "CPU utilization and throttled periods"],
      ["Connection pool", "Concurrency and queueing", "Pool utilization and pending requests"],
      ["Memory limit", "OOM risk and buffer headroom", "Working set and restarts"],
      ["TLS and filters", "Per-request CPU", "CPU per 1,000 rps at the same hop count"],
    ],
  },
  { type: "sim", simId: "mesh-sidecar-overhead" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 12,000 rps across four pods, each sidecar handled 3,000 rps. With three hops and 70m of CPU per 1,000 rps per hop, demand was 630m against a 120m limit. The sidecar was throttled for most of each scheduling period. p99 rose to about two seconds, application timeouts crossed 18%, and the 32-connection pool looked nearly full because slow responses held connections longer.",
  },
  {
    type: "p",
    text: "Raising the CPU limit to 1,000m removed the throttle and dropped p99 to tens of milliseconds. The pool stopped looking saturated because connections were released faster. Raising the application timeout would have kept failed requests in flight longer; adding memory would not have changed per-request CPU; adding retries would have increased load. The resource that was exhausted was the one that mattered.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Sidecar CPU usage and `container_cpu_cfs_throttled_periods_total` for the proxy container.",
      "Per-hop latency in a trace, compared with a no-mesh or pre-mesh baseline.",
      "Upstream connection pool gauges: active connections, pending requests, and overflow.",
      "Application timeout rate and the gap between application latency and end-to-end latency.",
      "Sidecar memory working set and restarts, which are a separate failure mode from latency.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Measure the same request rate with and without the mesh, then compare per-hop latency. Check CPU throttling before tuning the pool. If the proxy is throttled, the pool and the application tail are symptoms, not the first cause.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Establish a no-mesh baseline for the same request rate and payload.",
      "Compute per-pod CPU demand and set the sidecar limit above it with headroom.",
      "Reduce per-pod rate by adding replicas if the limit is already at the node's capacity.",
      "Remove unnecessary hops or filters that add per-request work.",
      "Size the pool for concurrency after the latency fix, not before it.",
      "Re-measure p99 and throttling after each change; do not change several resources at once.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher CPU limit protects the tail and lets the sidecar compete with the application for node CPU.",
      "More replicas reduce per-pod demand and add connection and configuration overhead.",
      "Removing a mesh hop reduces cost and removes policy or observability at that hop.",
      "A larger connection pool absorbs bursts and can increase load on an already slow upstream.",
      "A longer application timeout hides the tail and holds resources longer; it does not remove the cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "measure-overhead",
    question:
      "Latency rose after the mesh was enabled. How do you measure the sidecar's share, and what would you compare?",
    difficulty: 3,
    hints: [
      "Use the same load and payload.",
      "A mean will hide the cost you care about.",
    ],
    answer:
      "I would run the same request rate and payload with and without sidecars and compare the full latency distribution, not just the mean. I would look at p50, p99, and p999, and then use a trace to separate per-hop proxy time from application time. I would also check CPU throttling, pool utilization, and connection reuse on the sidecar. If the no-mesh baseline is not available, I would compare the same service across meshed and unmeshed environments or use a canary with one unmeshed path.",
    followUps: [
      "What if you cannot remove the sidecar in production?",
      "Which percentile would you use for a timeout SLO?",
      "How does payload size change the comparison?",
    ],
    redFlags: [
      "Compares only averages.",
      "Changes several variables at once.",
      "Blames the application without a baseline.",
    ],
    rubric: [
      "Uses a controlled baseline.",
      "Compares tails.",
      "Checks CPU and pool signals.",
      "Separates per-hop time.",
    ],
  },
  {
    id: "throttling-tail",
    question:
      "The sidecar CPU limit is 100m, usage is 180m, and p99 is 900ms. Explain the mechanism and the first fix.",
    difficulty: 3,
    hints: [
      "Usage above the limit is not allowed to run continuously.",
      "Throttling pauses the process; queued work waits.",
    ],
    answer:
      "The cgroup limit is below demand, so the kernel throttles the sidecar for part of each scheduling period. While it is throttled, requests wait in the proxy or in the kernel queue. The wait adds tail latency even though the average CPU usage may look modest across the period. The first fix is to raise the limit above measured demand with headroom, or reduce per-pod request rate. Then recheck throttling and p99. If the node is already saturated, adding replicas is the safer direction.",
    followUps: [
      "Which metric proves throttling?",
      "Why can average CPU look low while throttling is high?",
      "What if the application container is also throttled?",
    ],
    redFlags: [
      "Raises the application timeout.",
      "Adds memory.",
      "Ignores the cgroup limit.",
    ],
    rubric: [
      "Explains CFS throttling.",
      "Connects throttling to queueing.",
      "Raises the limit or reduces rate.",
      "Checks the application container.",
    ],
  },
  {
    id: "pool-sizing",
    question:
      "After fixing CPU throttling, the sidecar pool still shows pending requests. How do you decide whether to raise the pool?",
    difficulty: 4,
    hints: [
      "Concurrency equals rate times time in the proxy and upstream.",
      "A larger pool can amplify load on a slow dependency.",
    ],
    answer:
      "I would measure concurrency and upstream response time first. If the upstream is slow, raising the pool lets more requests wait and can increase load on the dependency. I would fix the upstream latency or add capacity there before raising the pool. If the upstream is healthy and concurrency is genuinely above the configured pool, I would raise the pool with headroom and watch upstream load and error rate. I would also check whether pending requests are retries or fresh traffic.",
    followUps: [
      "How does retry volume change pool sizing?",
      "What is the risk of an unbounded pool?",
      "How would you test the new size?",
    ],
    redFlags: [
      "Raises the pool without checking upstream latency.",
      "Ignores retries.",
      "Sets the pool to unlimited.",
    ],
    rubric: [
      "Measures concurrency and upstream time.",
      "Treats the pool as a bound.",
      "Checks retry load.",
      "Tests before and after.",
    ],
  },
];

const checklist = [
  {
    title: "Before enabling the mesh",
    items: [
      "Measure a no-mesh baseline for p50, p99, and p999 at production load.",
      "Size sidecar CPU from per-pod request rate and hop count, with headroom.",
      "Set memory limits for connections, buffers, and config, not for latency.",
      "Size connection pools from measured concurrency.",
      "Decide which hops are necessary and which filters add per-request cost.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare p99 with the no-mesh baseline.",
      "Check sidecar CPU throttling before tuning the pool.",
      "Check upstream response time and pending requests.",
      "Check whether the application container is also throttled.",
      "Change one resource at a time and re-measure.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the per-hop cost and the load at which it changed.",
      "Right-size CPU and pool from measured demand.",
      "Add alerts on throttling and pending requests.",
      "Review whether all mesh hops are necessary.",
      "Re-run the baseline after upgrades or filter changes.",
    ],
  },
];

const references = [
  {
    title: "Envoy performance FAQ",
    url: "https://www.envoyproxy.io/docs/envoy/latest/faq/performance/how_fast_is_envoy",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Throughput and latency depend on configuration, filters, TLS, and hardware.",
  },
  {
    title: "Envoy circuit breaking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Connection pools, pending requests, and concurrency limits per cluster.",
  },
  {
    title: "Kuma observability",
    url: "https://kuma.io/docs/latest/explore/observability/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Mesh-level telemetry for proxy and service behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mesh-sidecar-overhead": {
      model: sidecarOverheadModel,
      presets,
      instructions:
        "Start Healthy, then set hops to zero for the baseline. Apply Throttled and watch CPU, throttling, and p99 together. Apply Recovery and change one resource at a time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. Pod count, CPU cost per 1,000 rps, and overhead are teaching values, not Envoy benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-sidecar-patterns",
    "case-composite-sidecar-cpu",
    "mesh-canary",
    "mesh-timeouts",
  ],
};
