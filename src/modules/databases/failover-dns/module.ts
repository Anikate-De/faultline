import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_RECONNECT_S = 2;
const WRITE_RATE = 400;

const params = [
  {
    id: "failover",
    label: "Writer failover",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 starts a writer failover at the current time. 0 keeps the original writer.",
    format: "count" as const,
  },
  {
    id: "dnsTtlS",
    label: "DNS TTL",
    min: 1,
    max: 300,
    step: 1,
    value: 30,
    unit: " s",
    group: "DNS",
    help: "How long a resolver or client may cache the writer endpoint's address. A shorter TTL shortens the stale-address window, not the lifetime of an open connection.",
    format: "number" as const,
  },
  {
    id: "poolRecycleS",
    label: "Pool recycle time",
    min: 0,
    max: 600,
    step: 10,
    value: 60,
    unit: " s",
    group: "Connection pool",
    help: "How long a pool keeps a connection before replacing it. 0 means the pool validates on checkout and replaces a broken connection immediately.",
    format: "number" as const,
  },
  {
    id: "poolConnections",
    label: "Pooled connections",
    min: 100,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " conns",
    group: "Connection pool",
    help: "Total pooled client connections across the fleet. This is the population that rebuilds connections when the old writer fails.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface DnsState {
  active: boolean;
  ttl: number;
  recycle: number;
  pool: number;
  convergence: number;
  elapsed: number;
  moved: boolean;
}

function advanceState(flags: SimFrame["flags"], p: Params, dt: number): DnsState {
  const active = num(p, "failover", 0) >= 0.5;
  const ttl = clamp(Math.round(num(p, "dnsTtlS", 30)), 1, 300);
  const recycle = clamp(Math.round(num(p, "poolRecycleS", 60)), 0, 600);
  const pool = clamp(Math.round(num(p, "poolConnections", 2_000)), 100, 10_000);
  const convergence = active ? Math.max(ttl, recycle) + BASE_RECONNECT_S : 0;
  const wasActive = flags.failoverActive === 1;
  const priorElapsed = Number(flags.failoverElapsed ?? 0);
  let elapsed = wasActive && Number.isFinite(priorElapsed) ? Math.max(0, priorElapsed) : 0;
  let moved = flags.trafficMoved === 1;
  if (!active) {
    elapsed = 0;
    moved = false;
  } else {
    if (!wasActive) {
      elapsed = 0;
      moved = false;
    }
    elapsed += Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (elapsed >= convergence) moved = true;
  }
  return { active, ttl, recycle, pool, convergence, elapsed, moved };
}

interface Computed extends DnsState {
  stale: boolean;
  timeToMove: number;
  staleShare: number;
  reconnect: number;
  failedWrites: number;
  appHealth: Health;
  dnsHealth: Health;
  poolHealth: Health;
  writerHealth: Health;
}

function compute(state: DnsState): Computed {
  const stale = state.active && !state.moved;
  const timeToMove = stale ? state.convergence : 0;
  const staleShare = stale ? 100 : 0;
  const reconnect = stale ? state.pool / 2 : 0;
  const failedWrites = stale ? WRITE_RATE : 0;
  const appHealth: Health = !state.active
    ? "ok"
    : state.moved
      ? "ok"
      : state.convergence >= 90
        ? "crit"
        : "warn";
  const dnsHealth: Health = !stale ? "ok" : state.ttl >= 120 ? "crit" : state.ttl >= 60 ? "warn" : "ok";
  const poolHealth: Health = !stale ? "ok" : state.recycle >= 300 ? "crit" : state.recycle >= 120 ? "warn" : "ok";
  const writerHealth: Health = "ok";
  return {
    ...state,
    stale,
    timeToMove,
    staleShare,
    reconnect,
    failedWrites,
    appHealth,
    dnsHealth,
    poolHealth,
    writerHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.6);
  const rows: [string, number, number][] = [
    ["convergence", values.timeToMove, 0.5],
    ["stale-share", values.staleShare, 0.2],
    ["reconnect", values.reconnect, 2],
    ["failed-writes", values.failedWrites, 2],
    ["dns-ttl", values.ttl, 0],
    ["pool-recycle", values.recycle, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      value <= 0 ? 0 : Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(seed: number, flags: SimFrame["flags"], state: DnsState): SimFrame {
  const values = compute(state);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        health: values.appHealth,
        utilization: clamp(values.timeToMove / 300),
        sublabel: values.stale
          ? `${formatCount(values.pool)} pooled conns · still on old writer`
          : `${formatCount(values.pool)} pooled conns · ${values.active ? "new writer" : "current writer"}`,
        detail: values.stale
          ? "Writes are still using the old writer's address or an open connection to it. The database has already promoted the new writer."
          : values.active
            ? "The application is writing to the promoted writer. Check that the pool has recycled stale connections, not just that DNS resolves."
            : "The application is writing to the current writer. No failover is in progress.",
        meta: { view: "flow" },
      },
      {
        id: "dns",
        label: "Writer endpoint DNS",
        kind: "dns",
        health: values.dnsHealth,
        utilization: clamp(values.ttl / 300),
        sublabel: `${values.ttl}s TTL · ${
          values.stale ? "old address may be cached" : values.active ? "new address" : "current address"
        }`,
        detail: "Managed failover changes the endpoint's DNS record. Resolvers and client DNS caches can keep the old address until the TTL expires.",
        meta: { view: "flow" },
      },
      {
        id: "pool",
        label: "Connection pool",
        kind: "mesh",
        health: values.poolHealth,
        utilization: clamp(values.recycle / 600),
        sublabel: `${values.recycle === 0 ? "validate on checkout" : `${values.recycle}s recycle`}`,
        detail: "An open connection does not re-resolve DNS. It keeps using the old address until it breaks or the pool retires it.",
        meta: { view: "flow" },
      },
      {
        id: "writer",
        label: "Writer · current primary",
        kind: "db",
        role: "primary",
        health: values.writerHealth,
        utilization: clamp(values.reconnect / 3_000),
        sublabel: values.stale
          ? "promoted · traffic not arrived"
          : values.active
            ? "promoted · receiving writes"
            : "receiving writes",
        detail: values.stale
          ? "The promoted writer is available, but it cannot receive writes that clients are still sending to the old address. The database recovery and the application recovery are separate clocks."
          : values.active
            ? "The promoted writer is receiving writes. Verify that no client remains pinned to the old address."
            : "The writer endpoint resolves to this instance. No failover is in progress.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-dns", "app", "dns", 1, values.appHealth, "resolve"),
      edge("dns-pool", "dns", "pool", 1, values.dnsHealth, "endpoint"),
      edge("pool-writer", "pool", "writer", values.stale ? 0 : 1, values.writerHealth, "connections"),
    ],
    metrics: [
      metric("convergence", "Time to new writer", values.timeToMove, "s", 30, 90, "number"),
      metric("stale-share", "Writes still on old writer", values.staleShare, "%", undefined, undefined, "percent"),
      metric("reconnect", "Reconnect attempts", values.reconnect, " conn/s", 500, 2_000, "rps"),
      metric("failed-writes", "Failed writes", values.failedWrites, " writes/s", undefined, undefined, "rps"),
      metric("dns-ttl", "DNS TTL", values.ttl, "s", undefined, undefined, "number"),
      metric("pool-recycle", "Pool recycle", values.recycle, "s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { ...flags, seed },
    summary: values.stale
      ? `${values.ttl}s DNS TTL and ${values.recycle}s pool recycle converge in about ${values.convergence}s. Writes still target the old writer; ${formatCount(
          values.reconnect,
        )} reconnects/s.`
      : values.active
        ? `Traffic reached the promoted writer after about ${values.convergence}s. ${formatCount(
            values.pool,
          )} pooled connections were rebuilt.`
        : "No failover. The writer endpoint resolves to the current writer.",
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "convergence",
    metricId: "convergence",
    warn: 30,
    crit: 90,
    title: "Application writes take too long to reach the promoted writer",
    cause:
      "The time to move is bounded by the slower of the DNS cache lifetime and the pool's connection recycle time, plus the reconnect. A short DNS TTL cannot help a pool that keeps an open connection to the old address.",
    fix:
      "Lower the DNS TTL, validate or recycle pooled connections faster, or put a stable proxy endpoint in front of the writer. Measure DNS and pool time separately before changing both.",
    checkFirst: [
      "Compare the DNS TTL with the pool's maximum connection lifetime and validation setting.",
      "Check whether the old writer's IP still appears in connection errors.",
      "Check whether the client resolves the writer endpoint or a cached IP at startup.",
    ],
  },
  {
    id: "reconnect",
    metricId: "reconnect",
    warn: 500,
    crit: 2_000,
    title: "Reconnect attempts are arriving as a synchronized burst",
    cause:
      "When the old writer fails, every pooled connection can break at the same time. A short TTL and an aggressive retry policy make the whole fleet resolve and reconnect together, which can overwhelm the new writer.",
    fix:
      "Add jitter and exponential backoff, use a proxy that holds the client connections, and stagger pool recycling. Warm the new writer's connection capacity before a planned failover.",
    checkFirst: [
      "Check whether reconnect attempts cluster in one or two seconds.",
      "Check the client retry policy for fixed delays and no jitter.",
      "Check whether a proxy is in the path or every client reconnects directly.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const failoverDnsModel: SimModel = {
  id: "databases-failover-dns",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const state = advanceState({}, defaults(), 0);
    const frame = buildFrame(seed, {}, state);
    seedSeries(frame, compute(state), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const state = advanceState(frame.flags, p, dt);
    const values = compute(state);
    const next = buildFrame(Number(frame.flags.seed ?? 20261110), frame.flags, state);
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];

    const wasActive = frame.flags.failoverActive === 1;
    if (values.active && !wasActive) {
      pushEvent(next, {
        id: "writer-failover-started",
        at: frame.t,
        severity: "warn",
        title: "Writer failed over; clients may still use the old address",
        detail:
          "The database has promoted a new writer. Existing connections and cached DNS entries can keep sending traffic to the old instance until they expire or are recycled.",
        nodeId: "writer",
        metricId: "convergence",
      });
    }
    if (values.stale && values.recycle > values.ttl && frame.flags.stalePoolLogged !== 1) {
      pushEvent(next, {
        id: "pool-outlives-dns",
        at: frame.t,
        severity: "warn",
        title: "The connection pool outlives the DNS TTL",
        detail: `DNS may refresh in ${values.ttl}s, but the pool can keep a connection for ${values.recycle}s. Open connections do not re-resolve the endpoint.`,
        nodeId: "pool",
        metricId: "pool-recycle",
      });
    }
    if (values.active && values.moved && frame.flags.trafficMoved !== 1) {
      pushEvent(next, {
        id: "traffic-reached-new-writer",
        at: frame.t,
        severity: "info",
        title: "Traffic reached the promoted writer",
        detail: `Writes moved after about ${values.convergence}s. Reconnect attempts have stopped; verify that the pool is healthy and that no client is still pinned to the old address.`,
        nodeId: "writer",
        metricId: "convergence",
      });
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      failoverActive: values.active ? 1 : 0,
      failoverElapsed: values.active ? values.elapsed : 0,
      trafficMoved: values.moved ? 1 : 0,
      stalePoolLogged: values.stale && values.recycle > values.ttl ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const state = advanceState(_frame.flags, p, 0);
    const values = compute(state);
    const items = [
      `The DNS TTL is ${values.ttl}s and the pool recycle time is ${
        values.recycle === 0 ? "validation on checkout" : `${values.recycle}s`
      }. The modeled time to the new writer is about ${values.convergence}s.`,
      values.recycle > values.ttl
        ? "The pool is the slower boundary. Shortening DNS does not help while the pool keeps an open connection to the old address."
        : "DNS is the slower boundary. The pool is recycling faster than the cached address expires.",
    ];
    if (values.stale) {
      items.push(
        `All modeled writes still target the old writer, about ${formatCount(
          values.reconnect,
        )} connection attempts/s are in flight, and the promoted writer is not receiving them.`,
      );
    } else if (values.active) {
      items.push("Traffic has moved to the promoted writer. Confirm that the old writer is fenced from writes.");
    } else {
      items.push("No failover is in progress. The endpoint resolves to the current writer.");
    }
    items.push("A pool connection is a long-lived socket. It does not re-resolve DNS on every query.");
    items.push("Faster convergence is not free: synchronized reconnects can overload the new writer.");
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
    description: "No failover. A 30s TTL and a 60s pool recycle are both configured, and the writer endpoint resolves to the current writer.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Failover at peak",
    description: "A 30s TTL and 30s pool recycle converge in about 32s. The promoted writer sees 1,500 reconnect attempts per second.",
    tone: "warn",
    params: defaults({ failover: 1, dnsTtlS: 30, poolRecycleS: 30, poolConnections: 3_000 }),
  },
  {
    id: "failure",
    label: "Stale DNS and pool",
    description: "A 120s TTL and a 300s pool recycle leave writes on the old writer for about 302s, with 3,000 reconnect attempts per second.",
    tone: "crit",
    params: defaults({ failover: 1, dnsTtlS: 120, poolRecycleS: 300, poolConnections: 6_000 }),
  },
  {
    id: "recovery",
    label: "Validated pool and short TTL",
    description: "A 5s TTL and checkout validation converge in about 7s, with 400 reconnect attempts per second.",
    tone: "ok",
    params: defaults({ failover: 1, dnsTtlS: 5, poolRecycleS: 0, poolConnections: 800 }),
  },
  {
    id: "stale-pool",
    label: "Fast DNS, stale pool",
    description: "A 5s TTL is wasted because the pool keeps connections for 300s. Writes stay on the old writer for about 302s.",
    tone: "crit",
    params: defaults({ failover: 1, dnsTtlS: 5, poolRecycleS: 300, poolConnections: 800 }),
  },
];

const experiment: Experiment = {
  id: "predict-dns-vs-pool",
  title: "Predict what actually delays the cutover",
  simId: "failover-dns",
  question:
    "The writer fails over. DNS TTL is 5 seconds, but the connection pool keeps a connection for 300 seconds. How long before writes reach the new writer?",
  prediction: {
    options: [
      { id: "five", label: "About 5 seconds, because the DNS TTL controls the cutover." },
      { id: "three-hundred", label: "About 302 seconds, because the pool keeps the old connection." },
      { id: "zero", label: "Immediately; the database updates in-memory connections at failover." },
      { id: "six-hundred", label: "About 600 seconds, because both delays add together." },
    ],
    correctOptionId: "three-hundred",
    explanation:
      "The slowest boundary wins, it does not add: the pool's 300-second recycle plus the reconnect gives about 302 seconds. The 5-second DNS TTL only affects new resolutions. An open connection keeps using the old address until it breaks or the pool retires it.",
  },
  setup: defaults({ failover: 1, dnsTtlS: 5, poolRecycleS: 300, poolConnections: 800 }),
  runFor: 20,
  observe: [
    "Writes still on the old writer stays at 100%.",
    "Time to new writer is about 302s and crosses the critical threshold.",
    "Reconnect attempts are 400 per second, below the storm warning.",
    "The DNS node is healthy at 5s, while the pool node is critical at 300s.",
    "The promoted writer is available but not receiving the writes.",
  ],
  explain:
    "DNS resolves the writer endpoint to an address, and the pool stores an established connection to that address. A connection does not re-resolve DNS on every query. If the pool keeps the connection for 300 seconds, the client keeps writing to the old address even though DNS changed after 5 seconds. The two delays overlap; the slower one sets the cutover time.",
  fix: defaults({ failover: 1, dnsTtlS: 5, poolRecycleS: 0, poolConnections: 800 }),
  debrief:
    "Validating or recycling pooled connections on checkout reduces the cutover to about 7s: the 5s DNS TTL plus the reconnect. The pool was the real dependency, not DNS. Check both boundaries and measure them separately before shortening one and expecting the outage to move.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A database failover promotes a standby or another writer and changes which instance should receive writes. Managed services expose a stable name for that role, such as an RDS DB instance endpoint or an Aurora cluster writer endpoint. On failover, the service updates the DNS record to point at the new writer. The database recovery and the application recovery are separate clocks: the writer can be ready while clients still send traffic to the old address.",
  },
  {
    type: "p",
    text: "DNS is a cache with a time to live (TTL). A resolver, an operating system, or a language runtime can keep the old address until the record expires. A JVM caches DNS lookups, and AWS recommends configuring its TTL to no more than 60 seconds; some JVM configurations cache until restart. But DNS is only half the problem. A connection pool holds established TCP connections, and an open connection does not re-resolve the endpoint on every query. It keeps using the old address until it breaks, is validated, or is recycled. That is why a five-second TTL can still produce a five-minute outage.",
  },
  {
    type: "p",
    text: "A managed proxy changes the shape of the problem. RDS Proxy gives clients one stable endpoint, follows the current writer, and keeps idle client connections open during failover. Clients avoid DNS propagation and local caching. The proxy still cancels in-flight transactions, and it has its own pool limits and borrow timeouts. It moves the failure from DNS to the proxy's capacity and configuration.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application pool, DNS resolver and local cache, writer endpoint, current writer. After failover, the endpoint's record points at the new writer, but the pool still holds sockets to the old one. A new connection resolves DNS; an old connection does not. The cutover completes when the last stale connection is replaced and the new connections resolve the new address. An instance endpoint is different: it names one instance and does not follow the writer role, so an application configured with it will keep targeting the old node after promotion.",
  },
  {
    type: "compare",
    leftTitle: "Direct writer endpoint",
    rightTitle: "RDS Proxy endpoint",
    rows: [
      { label: "DNS dependency", left: "Client TTL and resolver cache", right: "Client sees a stable proxy name" },
      { label: "Existing connections", left: "Break on failover and reconnect", right: "Idle client connections survive" },
      { label: "In-flight work", left: "Fails with the connection", right: "Canceled transaction or statement" },
      { label: "New limit", left: "Database max_connections", right: "Proxy pool, borrow timeout, pinning" },
      { label: "Main failure mode", left: "Stale DNS or pooled connection", right: "Oversized pool or proxy dependency" },
    ],
  },
  {
    type: "p",
    text: "The time to move is roughly the slower of the DNS cache lifetime and the pool's recycle time, plus the reconnect. They overlap rather than add: if DNS expires at 30 seconds and the pool recycles at 300, the pool is the boundary. If the pool validates on checkout, the DNS TTL is usually the boundary. Jitter and backoff matter because the reconnect population can arrive in one burst.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to new writer: the modeled cutover from failover to writes reaching the promoted instance.",
      "Writes still on old writer: the share of traffic that has not moved, which should fall to zero.",
      "Reconnect attempts per second: the burst that can overwhelm the new writer.",
      "Failed writes per second while the old address is still in use.",
      "DNS TTL and pool recycle time side by side, so the slower boundary is visible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Stale DNS and pool. Read the time-to-new-writer number before moving either slider. Apply Fast DNS, stale pool to see that a short TTL does not fix a long-lived connection. Then use Validated pool to see the cutover collapse to the DNS boundary. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Failover timing, TTLs, pool recycle times, and reconnect rates are illustrative teaching values. RDS Multi-AZ failover is typically 60 to 120 seconds, and the application can take longer; those are different measurements. The simulation models the client convergence path, not the database's internal promotion time.",
  },
  { type: "sim", simId: "failover-dns" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The writer failed over and DNS updated in five seconds. The pool kept its old connections for 300 seconds, so writes stayed on the old address for about 302 seconds. The DNS node looked healthy while the pool node was critical. The promoted writer was available the whole time; the application had not moved.",
  },
  {
    type: "p",
    text: "With checkout validation, the pool replaced the broken connection and the cutover took about seven seconds: five seconds of DNS TTL plus the reconnect. The two delays overlapped rather than stacking. The fix was to change the slower boundary, not to shorten DNS further.",
  },
  {
    type: "p",
    text: "The reconnect burst is the second-order effect. Eight hundred pooled connections produced 400 attempts per second, which stayed below the warning. A larger fleet or a shorter retry interval can produce a synchronized storm that saturates the new writer even after DNS is correct.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "RDS events for failover started and completed, and the writer endpoint's current address.",
      "DNS: the endpoint's TTL, resolver cache behavior, and the JVM or runtime DNS cache setting. AWS recommends a JVM TTL of no more than 60 seconds.",
      "Connection pools: maximum lifetime, idle timeout, validation query or checkout validation, and the age of the oldest connection.",
      "Application errors: connection refused, read-only transaction, unknown host, or writes that still succeed against the old writer.",
      "RDS Proxy metrics: ClientConnections, DatabaseConnections, setup failures, and borrow latency if a proxy is in the path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Resolve the writer endpoint and compare it with the address the application is actually connected to. Then compare the DNS TTL with the pool's recycle and validation settings. If DNS is current but connections are old, the pool is the boundary; if both are current, check retries, endpoint configuration, and whether the old writer is still accepting writes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Separate the two clocks: measure database failover time separately from the application's time to first successful write.",
      "Set the DNS TTL low enough for the change rate, and configure the runtime's DNS cache. A TTL is not a guarantee that every client refreshes at that second.",
      "Validate connections on checkout or recycle them faster than the DNS TTL. A stale open socket ignores DNS entirely.",
      "Prefer a stable proxy endpoint such as RDS Proxy when every client reconnecting directly is too large a burst. Size the proxy pool for the post-failover writer.",
      "Add exponential backoff with jitter to reconnects. A fixed retry interval synchronizes the fleet.",
      "Fence the old writer from writes before or during promotion. A client that keeps writing to the old address must fail, not diverge.",
      "Rehearse the failover with production client counts and connection settings. A database-only failover test does not prove the application moves.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short DNS TTL increases resolver load and does nothing for an open connection.",
      "Aggressive pool validation adds a round trip or a health check to checkout, but shortens the stale-connection window.",
      "A proxy removes the client DNS and reconnect burst but adds a hop, a pool limit, and another component to operate.",
      "Faster reconnect reduces downtime but increases the burst on the new writer.",
      "Jitter spreads the burst but can make the last client arrive later.",
      "A database failover can be complete while the application is still down; measure both.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-old-writer",
    question:
      "The database failed over, but the application still writes to the old primary. What are the possible causes?",
    difficulty: 3,
    hints: [
      "Separate name resolution from open connections.",
      "The old writer may also still be reachable.",
    ],
    answer:
      "I would check three layers. First, DNS: the client or resolver may still have the old address cached until the TTL expires, and some runtimes cache DNS longer than the record's TTL. Second, the connection pool: an established connection does not re-resolve DNS, so it can keep using the old address until it breaks, is validated, or is recycled. Third, the endpoint and fencing: the application may be configured with an instance address instead of the writer endpoint, or the old writer may still accept writes when it should be fenced. I would compare the resolved address with the address in the active connections and check whether the writes are succeeding or failing against the old node.",
    followUps: [
      "How would you prove which layer is responsible?",
      "What does the old writer do with writes after promotion?",
      "How does a proxy change the answer?",
    ],
    redFlags: [
      "Blames DNS only.",
      "Ignores pooled connections.",
      "Assumes the old writer is immediately unreachable.",
    ],
    rubric: [
      "Separates DNS cache from open connections.",
      "Checks endpoint configuration and fencing.",
      "Names a way to compare resolved and connected addresses.",
      "Considers whether old writes are succeeding.",
    ],
  },
  {
    id: "proxy-dns",
    question: "How does RDS Proxy change the DNS and reconnect path during failover?",
    difficulty: 3,
    hints: [
      "The client connects to a stable proxy endpoint.",
      "The proxy still has a database pool and in-flight work.",
    ],
    answer:
      "The client connects to the proxy endpoint, which stays stable across failover. The proxy follows the current writer and reconnects its database pool. Idle client connections stay open, so clients avoid DNS propagation, local DNS caching, and connection timeouts. That removes the client-side DNS race and reduces the reconnect burst to the proxy pool. It does not preserve an in-flight transaction or statement; those are canceled. The proxy also has its own limits: pool size, borrow timeout, idle timeout, and pinning. I would still size the pool for the post-failover writer and test the path end to end.",
    followUps: [
      "What still fails during failover through a proxy?",
      "How does the proxy pool size affect the new writer?",
      "When would a direct endpoint be simpler?",
    ],
    redFlags: [
      "Says no connections fail.",
      "Claims the proxy removes the need to size connections.",
      "Ignores in-flight transactions.",
    ],
    rubric: [
      "Names the stable endpoint.",
      "Explains idle connection preservation.",
      "Keeps in-flight cancellation.",
      "Names proxy limits.",
    ],
  },
  {
    id: "reduce-cutover",
    question:
      "How do you reduce the time from database failover to the application writing to the new primary without causing a reconnect storm?",
    difficulty: 4,
    hints: [
      "Find the slower boundary first.",
      "Spread the reconnect instead of eliminating the delay.",
    ],
    answer:
      "I would measure the two boundaries separately: DNS cache expiry and pool connection replacement. Then I would fix the slower one. If DNS is slower, lower the TTL and configure the runtime cache. If the pool is slower, validate on checkout or recycle connections faster. To avoid a storm, I would add exponential backoff with jitter, stagger pool recycling, and consider a proxy that holds client connections and reconnects only its pool. I would also fence the old writer and rehearse with production client counts. The goal is to move the cutover to the slower boundary and spread the reconnect, not to make every client retry at once.",
    followUps: [
      "How would you measure the two boundaries?",
      "What does jitter cost?",
      "How would you test the change safely?",
    ],
    redFlags: [
      "Shortens DNS without checking the pool.",
      "Removes all retry delays.",
      "Tests only the database, not the application.",
    ],
    rubric: [
      "Measures DNS and pool separately.",
      "Fixes the slower boundary.",
      "Adds jitter or a proxy.",
      "Rehearses with production client behavior.",
    ],
  },
];

const checklist = [
  {
    title: "Before the failover",
    items: [
      "Applications use the writer endpoint or a stable proxy endpoint, not an instance address.",
      "DNS TTL and runtime DNS caching are configured and documented.",
      "Pool maximum lifetime and checkout validation are shorter than the acceptable stale-connection window.",
      "Reconnects use exponential backoff with jitter.",
      "The old writer is fenced from writes during and after promotion.",
      "A failover test measures time to first successful application write, not only database promotion.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Resolve the writer endpoint and compare it with the address in active connections.",
      "Check whether writes are failing or succeeding against the old writer.",
      "Check the reconnect rate and whether it is clustered in one burst.",
      "Check pool validation, maximum lifetime, and idle timeout.",
      "Record database failover time separately from application recovery time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the slower boundary: DNS, pool, or retry policy.",
      "Verify that no client is still pinned to the old address.",
      "Adjust the pool size for the promoted writer's capacity.",
      "Update the runbook with the measured cutover time and the next limit.",
    ],
  },
];

const references = [
  {
    title: "Failing over a Multi-AZ DB instance for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "DNS record changes on failover, typical failover timing, and JVM DNS TTL guidance.",
  },
  {
    title: "RDS Proxy concepts and terminology",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How the proxy follows the writer, preserves idle client connections, and avoids DNS propagation and local caching.",
  },
  {
    title: "Failing over an Amazon Aurora DB cluster",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-failover.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Promoting a reader to the primary and the cluster writer endpoint's role.",
  },
  {
    title: "Amazon RDS Proxy",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed pooling, failover resilience, and proxy quotas and limitations.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "failover-dns": {
      model: failoverDnsModel,
      presets,
      instructions:
        "Start healthy, then apply Stale DNS and pool. Compare the DNS and pool nodes, then apply Fast DNS, stale pool and Validated pool to see which boundary controls the cutover.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Failover timing, TTLs, pool recycling, reconnect rates, and the 400 writes/s workload are teaching inputs, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-rds-proxy",
    "databases-cross-region-rpo",
    "databases-connection-storm",
  ],
};
