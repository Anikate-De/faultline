import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITER_CAPACITY = 1_200;
const REPLICA_CAPACITY = 900;
const REPLICAS = 3;
const READ_AFTER_WRITE_SHARE = 0.25;
const READ_COST = 0.35;
const WRITE_COST = 1;
const READ_SPREAD_MS = 10_000;

const params = [
  {
    id: "replicaLagMs",
    label: "Replica lag",
    min: 0,
    max: 10_000,
    step: 50,
    value: 300,
    unit: " ms",
    group: "Replica",
    help: "How far the replica is behind the primary. A read can see a write only after the replica has replayed it.",
    format: "ms" as const,
  },
  {
    id: "stickyWindowMs",
    label: "Post-write primary window",
    min: 0,
    max: 10_000,
    step: 50,
    value: 500,
    unit: " ms",
    group: "Policy",
    help: "After a write, route that session's reads to the primary for this long. Zero means no stickiness.",
    format: "ms" as const,
  },
  {
    id: "replicaReadShare",
    label: "Reads eligible for replicas",
    min: 0,
    max: 100,
    step: 1,
    value: 80,
    unit: "%",
    group: "Policy",
    help: "Share of read traffic the router may send to replicas. The rest goes to the primary for freshness.",
    format: "percent" as const,
  },
  {
    id: "readRate",
    label: "Read traffic",
    min: 100,
    max: 10_000,
    step: 100,
    value: 3_000,
    unit: " reads/s",
    group: "Traffic",
    help: "Total reads per second. About a quarter of them are assumed to follow a recent write.",
    format: "rps" as const,
  },
  {
    id: "writeRate",
    label: "Write traffic",
    min: 50,
    max: 3_000,
    step: 50,
    value: 300,
    unit: " writes/s",
    group: "Traffic",
    help: "Committed writes per second. Writes always use the primary and create the read-after-write risk.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  lagMs: number;
  stickyMs: number;
  replicaShare: number;
  readRate: number;
  writeRate: number;
  stickyCoverage: number;
  staleShare: number;
  staleReads: number;
  stickyPrimaryReads: number;
  primaryReads: number;
  replicaReads: number;
  writerLoad: number;
  replicaLoad: number;
  routerHealth: Health;
  writerHealth: Health;
  replicaHealth: Health;
}

function compute(p: Params): Computed {
  const lagMs = Math.max(0, num(p, "replicaLagMs", 300));
  const stickyMs = Math.max(0, num(p, "stickyWindowMs", 500));
  const replicaShare = clamp(num(p, "replicaReadShare", 80), 0, 100) / 100;
  const readRate = Math.max(0, num(p, "readRate", 3_000));
  const writeRate = Math.max(0, num(p, "writeRate", 300));
  const stickyCoverage = lagMs <= 0 ? 0 : clamp(stickyMs / lagMs, 0, 1);
  const staleWindowMs = Math.max(0, lagMs - stickyMs);
  const staleShare = READ_AFTER_WRITE_SHARE * replicaShare * (staleWindowMs / READ_SPREAD_MS) * 100;
  const staleReads = readRate * (staleShare / 100);
  const stickyPrimaryReads = readRate * READ_AFTER_WRITE_SHARE * replicaShare * stickyCoverage;
  const primaryReads = readRate * (1 - replicaShare) + stickyPrimaryReads;
  const replicaReads = Math.max(0, readRate * replicaShare - stickyPrimaryReads);
  const writerLoad = Math.min(200, ((writeRate * WRITE_COST + primaryReads * READ_COST) / WRITER_CAPACITY) * 100);
  const replicaLoad = Math.min(
    200,
    ((replicaReads * READ_COST) / (REPLICAS * REPLICA_CAPACITY)) * 100,
  );
  const routerHealth: Health = staleShare >= 10 ? "crit" : staleShare >= 1 ? "warn" : "ok";
  const writerHealth: Health = writerLoad >= 90 ? "crit" : writerLoad >= 70 ? "warn" : "ok";
  const replicaHealth: Health = replicaLoad >= 90 ? "crit" : replicaLoad >= 75 ? "warn" : "ok";
  return {
    lagMs,
    stickyMs,
    replicaShare,
    readRate,
    writeRate,
    stickyCoverage,
    staleShare,
    staleReads,
    stickyPrimaryReads,
    primaryReads,
    replicaReads,
    writerLoad,
    replicaLoad,
    routerHealth,
    writerHealth,
    replicaHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMs(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.7);
  const rows: [string, number, number][] = [
    ["stale-read-share", values.staleShare, 0.2],
    ["stale-read-rate", values.staleReads, 4],
    ["writer-load", values.writerLoad, 0.5],
    ["reader-load", values.replicaLoad, 0.4],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const totalOps = Math.max(1, values.readRate + values.writeRate);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "User session",
        kind: "client",
        health: values.routerHealth,
        sublabel: `${formatCount(values.readRate)} reads/s · ${formatCount(values.writeRate)} writes/s`,
        detail: `About ${Math.round(
          READ_AFTER_WRITE_SHARE * 100,
        )}% of reads are modeled as following a recent write. Those reads decide whether the session can use a replica.`,
        meta: { view: "flow" },
      },
      {
        id: "router",
        label: "Read router",
        kind: "mesh",
        health: values.routerHealth,
        sublabel: `${Math.round(values.replicaShare * 100)}% to replicas · ${formatMs(values.stickyMs)} sticky`,
        detail: `The router chooses between the primary and the replicas per read or per session. It does not know that a replica has replayed a write unless the application passes a version boundary.`,
        meta: { view: "flow", staleShare: values.staleShare },
      },
      {
        id: "primary",
        label: "Primary",
        kind: "db",
        role: "primary",
        health: values.writerHealth,
        utilization: clamp(values.writerLoad / 100),
        sublabel: `${Math.round(values.writerLoad)}% loaded · ${formatCount(values.primaryReads)} read/s`,
        detail: `The primary serves every write plus the reads the router keeps for freshness. Every read moved off a replica lands here, so consistency has a capacity price.`,
        meta: { view: "flow" },
      },
      {
        id: "replica",
        label: `${REPLICAS} Read replicas`,
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: clamp(values.replicaLoad / 100),
        sublabel: `${Math.round(values.replicaLoad)}% loaded · ${formatMs(values.lagMs)} behind`,
        detail: `Replicas serve reads at their own point in time. A read routed here before replay completes returns the old value, even though the write was committed.`,
        meta: { view: "flow", lag: values.lagMs / 1_000 },
      },
    ],
    edges: [
      edge("client-router", "client", "router", clamp((values.readRate + values.writeRate) / totalOps), values.routerHealth),
      edge(
        "router-primary",
        "router",
        "primary",
        clamp((values.writeRate + values.primaryReads) / totalOps),
        values.writerHealth,
        "fresh",
      ),
      edge(
        "router-replica",
        "router",
        "replica",
        clamp(values.replicaReads / totalOps),
        values.replicaHealth,
        "replica read",
      ),
    ],
    metrics: [
      metric("stale-read-share", "Stale read share", values.staleShare, "%", 1, 10, "percent"),
      metric("stale-read-rate", "Stale reads", values.staleReads, " reads/s", 50, 300, "rps"),
      metric("writer-load", "Writer load", values.writerLoad, "%", 70, 90, "percent"),
      metric("reader-load", "Replica load", values.replicaLoad, "%", 75, 90, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatMs(values.stickyMs)} sticky after writes; ${values.staleShare.toFixed(
      1,
    )}% of reads can be stale (${formatCount(values.staleReads)}/s); writer ${Math.round(
      values.writerLoad,
    )}%, replicas ${Math.round(values.replicaLoad)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-read-share",
    metricId: "stale-read-share",
    warn: 1,
    crit: 10,
    title: "Read-after-write traffic is landing on stale replicas",
    cause:
      "The post-write primary window is shorter than the replica lag, so a read that follows a write can reach a replica before that write is replayed. More replica capacity or a lower average lag does not fix a single lagging replica.",
    fix:
      "Route a session to the primary for at least the lag after a write, pass a version boundary and wait for the replica to reach it, or serve the written object from a write-through cache. Choose per read path.",
    checkFirst: [
      "Compare the sticky window with the replica lag at the time of the read.",
      "Check whether the session is pinned to one replica by a pool or load balancer.",
      "Check which read paths actually need read-your-writes.",
    ],
  },
  {
    id: "writer-load",
    metricId: "writer-load",
    warn: 70,
    crit: 90,
    title: "Freshness routing is overloading the writer",
    cause:
      "Every read kept on the primary for consistency adds writer work. A long sticky window or a low replica share moves read traffic back to the instance that also serves writes.",
    fix:
      "Shorten the sticky window to the measured lag, use a version boundary so only reads that need freshness wait, or add read capacity only for paths that can tolerate staleness.",
    checkFirst: [
      "Compare the sticky window with the actual replica lag distribution.",
      "Check whether all reads are being treated as read-after-write.",
      "Check writer CPU, connections, and read latency together.",
    ],
  },
  {
    id: "reader-load",
    metricId: "reader-load",
    warn: 75,
    crit: 90,
    title: "The replica fleet is saturated",
    cause:
      "Too much read traffic is being sent to too few replicas. The router can only balance across the replicas it knows, and a pinned pool can concentrate load on one of them.",
    fix:
      "Add replicas, reduce read volume, or spread reads across a larger reader set. Check per-replica load before adding capacity.",
    checkFirst: [
      "Check load per replica, not only the fleet total.",
      "Check whether a connection pool is pinned to one replica.",
      "Check for one expensive query repeated across the fleet.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const routingModel: SimModel = {
  id: "databases-read-replica-routing",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.staleShare >= 1 && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "read-after-write-stale",
        at: frame.t,
        severity: values.staleShare >= 10 ? "crit" : "warn",
        title: "A read-after-write can land on a stale replica",
        detail: `The sticky window is ${formatMs(values.stickyMs)} and the replica is ${formatMs(
          values.lagMs,
        )} behind. About ${formatCount(values.staleReads)} reads/s can see the old value.`,
        nodeId: "router",
        metricId: "stale-read-share",
      });
    }
    next.flags.staleLogged = values.staleShare >= 1 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `${formatMs(values.lagMs)} of replica lag with a ${formatMs(
        values.stickyMs,
      )} post-write window leaves ${values.staleShare.toFixed(
        1,
      )}% of reads exposed, or ${formatCount(values.staleReads)} reads/s.`,
    ];
    if (values.staleShare >= 1) {
      items.push(
        "The exposed reads are the read-after-write share that goes to replicas and arrives before replay. Adding replicas does not reduce a shared lag; it only spreads the stale reads.",
      );
    } else {
      items.push(
        "The window covers the lag, so read-after-write traffic is routed to the primary until the replica is expected to be current.",
      );
    }
    items.push(
      `The freshness policy sends ${formatCount(
        values.primaryReads,
      )} reads/s to the primary, which is ${Math.round(values.writerLoad)}% of its capacity. ${formatCount(
        values.replicaReads,
      )} reads/s actually reach the replicas after the post-write share is diverted.`,
    );
    items.push(
      "A sticky window is time-based and assumes the lag estimate is right. A version boundary is precise: the replica waits until it has replayed the write's log position. A write-through cache only helps reads of the object that was just written.",
    );
    items.push(
      "The router needs session affinity for a post-write window. Without it, the next read from the same user can land on another instance that has no memory of the write.",
    );
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
    description: "A short sticky window covers the replica lag, with writer headroom to spare.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak reads",
    description: "High read traffic and a long sticky window keep reads fresh, but the writer absorbs the post-write share.",
    tone: "warn",
    params: defaults({ replicaLagMs: 2_000, stickyWindowMs: 2_500, replicaReadShare: 90, readRate: 5_000, writeRate: 450 }),
  },
  {
    id: "failure",
    label: "No stickiness",
    description: "Eight seconds of lag and no post-write window: 18% of reads can see an older profile value.",
    tone: "crit",
    params: defaults({ replicaLagMs: 8_000, stickyWindowMs: 0, replicaReadShare: 90, readRate: 4_000, writeRate: 500 }),
  },
  {
    id: "primary-only",
    label: "Primary only",
    description: "No stale reads, but every read lands on the writer and pushes it past capacity.",
    tone: "crit",
    params: defaults({ replicaLagMs: 1_000, stickyWindowMs: 0, replicaReadShare: 0, readRate: 4_000, writeRate: 500 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The window covers the lag; post-write reads stay on the writer while the rest of the eligible reads use replicas.",
    tone: "ok",
    params: defaults({ replicaLagMs: 2_000, stickyWindowMs: 2_500, replicaReadShare: 60, readRate: 2_200, writeRate: 350 }),
  },
];

const experiment: Experiment = {
  id: "save-then-read",
  title: "The profile that came back old",
  simId: "read-replica-routing",
  question:
    "A user saves a profile and reloads immediately. Replica lag is eight seconds, 90% of reads use replicas, and there is no post-write window. Why does the reload show the old value, and what is the smallest routing change?",
  prediction: {
    options: [
      { id: "replicas", label: "Add more replicas so the read has more places to land." },
      { id: "sticky", label: "Route that session to the primary for at least the replica lag after a write." },
      { id: "primary-all", label: "Move every read in the product to the primary permanently." },
      { id: "pool", label: "Reduce the connection pool size so the read waits longer." },
    ],
    correctOptionId: "sticky",
    explanation:
      "The write committed on the primary, but the replica had not replayed it yet. A read routed to that replica returned its older snapshot. A post-write primary window keeps that session's reads on the writer until the replica is expected to catch up. More replicas do not reduce the lag, and primary-only fixes the symptom by spending writer capacity on every read, not just the ones that need freshness.",
  },
  setup: defaults({ replicaLagMs: 8_000, stickyWindowMs: 0, replicaReadShare: 90, readRate: 4_000, writeRate: 500 }),
  runFor: 20,
  observe: [
    "Stale read share is 18% and the stale rate is about 720 reads per second.",
    "The writer is only 53% loaded because almost all reads go to replicas.",
    "The replica fleet is below 50% loaded; capacity is not the problem.",
    "The sticky window is zero, so nothing keeps the session on the writer after the write.",
  ],
  explain:
    "Read-your-writes is a session guarantee, not a replica property. The router must know that this session just wrote and must send its reads to a source that has the write. A time window is the simplest version: use the primary for a period at least as long as the observed lag. It costs writer capacity and needs session affinity. A version token is more precise but requires the application to carry and check the position.",
  fix: defaults({ replicaLagMs: 2_000, stickyWindowMs: 2_500, replicaReadShare: 80, readRate: 3_000, writeRate: 350 }),
  debrief:
    "With a 2.5-second window over a two-second lag, read-after-write traffic stays on the primary and stale reads fall to zero. The writer rises to about 64% because it serves the post-write reads, which is the price of freshness. About 60% of all reads still reach replicas after the post-write share is diverted.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Read routing is the policy that decides which reads go to the primary and which go to a replica. A simple read/write split sends all writes to the primary and all reads to replicas. That is fast and scalable, and it breaks the moment a user writes and then reads the same record. Read-your-writes is the guarantee that a user's own writes are visible to that user's subsequent reads. It is a session property, not a property of the replica.",
  },
  {
    type: "p",
    text: "There are three common ways to preserve it. A post-write primary window routes the session's reads to the primary for a fixed time after a write, usually at least the replica lag. A version boundary carries a log sequence number, transaction ID, or application version from the write and waits until the replica has reached it. A write-through cache updates the cached value as part of the write, so reads of that object do not need the replica at all. Each solves a different shape of problem.",
  },
  {
    type: "p",
    text: "The window is the easiest to add to an existing application, but it is time-based. If the lag is longer than the window, the read goes to the replica and can be stale. If the window is much longer than the lag, the writer serves reads it did not need to serve. A version boundary is precise but requires the driver, proxy, or application to carry the position and to wait. A write-through cache is fast for the written object but does not make arbitrary queries consistent, and it adds invalidation and expiry problems.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is user session, read router, primary or replica. The write path always goes to the primary. The router can sit in the application, in a proxy, or in a load-balancer rule. It needs two inputs: the read's consistency requirement and, for a window or version policy, the session's last write. Without session affinity, a load balancer can send the next read to a different application instance that has no memory of the write.",
  },
  {
    type: "table",
    headers: ["Policy", "Freshness", "Cost", "Best for"],
    rows: [
      ["Primary only", "Strongest", "All reads on the writer", "Low read volume or strict consistency"],
      ["Replica first", "Eventual", "Cheap reads, possible staleness", "Feeds, catalogs, analytics"],
      ["Post-write window", "Covers lag if the window is long enough", "Post-write reads on the writer; needs affinity", "Profile screens and session flows"],
      ["Version boundary", "Precise to the write position", "Wait for replay; needs position plumbing", "High-value transactions"],
      ["Write-through cache", "Fresh for the written object", "Cache invalidation and failure modes", "Reads of the object just changed"],
    ],
  },
  {
    type: "p",
    text: "The Aurora reader endpoint balances connections, not queries. A pool that opens one connection and keeps it will pin that session to one replica. That is fine for throughput, but it means a lagging replica can keep serving stale reads to the same pool even while the other replicas are current.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replica lag: how far the replica is behind at the read.",
      "Post-write primary window: how long a session stays on the writer after a write.",
      "Reads eligible for replicas: the share the router may send to the replica fleet.",
      "Stale read share and stale reads per second: the user-visible cost of the policy.",
      "Writer load and replica load: the capacity tradeoff between freshness and scale.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply No stickiness and read the stale share before moving any slider. Then raise the post-write window above the lag and watch stale reads fall while writer load rises. Apply Primary only to see the opposite cost, then run the experiment.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Two decisions to make",
    body: "First, decide which reads must see the user's own write. A profile page after save usually must; a product catalog or activity feed usually must not. Second, decide how much writer capacity you will spend on that guarantee. A window long enough to cover the worst lag spends more writer capacity than a version boundary that waits only when the replica is actually behind.",
  },
  {
    type: "p",
    text: "Lag, traffic, capacity, and the quarter-of-reads read-after-write assumption are illustrative teaching values. The thresholds are not provider limits; they are the points where this model makes the tradeoff visible.",
  },
  { type: "sim", simId: "read-replica-routing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write committed on the primary. The reload was routed to a replica that had not replayed that write, so it returned the previous profile. The replica was healthy and the write was durable; the problem was the read's consistency requirement, not database health. With no post-write window, every read-after-write that landed on a replica was exposed for the length of the lag.",
  },
  {
    type: "p",
    text: "Adding a post-write window kept the session on the primary until the replica was expected to catch up. Stale reads fell to zero, and writer load rose because the primary now served the post-write reads. Moving all reads to the primary also removed staleness, but it spent writer capacity on reads that never needed freshness and pushed the writer past its limit.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Application: read-after-write failures, stale-profile reports, and the session or request ID that can show which instance served the read.",
      "Aurora: AuroraReplicaLag per replica, plus the reader endpoint's connection distribution. A pinned pool shows up as one replica carrying most of the connections.",
      "PostgreSQL: pg_stat_replication on the primary for replay positions; pg_stat_activity on the replica for the queries a pinned pool is running.",
      "Router: the share of reads sent to each target, the sticky-window decision, and whether session affinity is actually present.",
      "Cache: hit rate, invalidation lag, and stale values after a write-through update.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the read follows a write in the same session, then compare the routing window with the replica lag. If the window is shorter than the lag, the read can be stale even on a healthy replica. If the window is much longer, check the writer load before extending it further.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the read paths that must see the user's own write. Do not apply session consistency to the whole product.",
      "For each path, choose a mechanism: post-write window, version boundary, write-through cache, or primary-only.",
      "Measure the replica lag distribution, not just the average. Set the window above the lag you are willing to cover.",
      "Ensure session affinity so the policy sees the same session on the next request.",
      "Use a version boundary where precision matters: return the write position to the client and have the replica wait until it reaches that position.",
      "Watch writer load and stale-read rate together after the change. A freshness fix that saturates the writer is a new incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer post-write window reduces stale reads and increases writer load. The right length is measured from lag, not guessed from a dashboard average.",
      "A version boundary is precise but needs position plumbing and a wait path; a replica that never reaches the position must time out to the primary.",
      "A write-through cache helps the object just written, but it does not make joins or list queries consistent and adds invalidation failure modes.",
      "Primary-only is the simplest guarantee and the least scalable read policy.",
      "Sending all reads to replicas is cheap and can break the first screen after a save, which is exactly the screen users notice.",
      "More replicas improve read capacity but do not reduce a shared lag or make a pinned session fresher.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-ryw",
    question: "A user saves a profile and immediately reloads the page. How do you guarantee the new value without sending every read to the primary?",
    difficulty: 3,
    hints: [
      "The guarantee is per session, not per query.",
      "A window and a version boundary solve different precision needs.",
    ],
    answer:
      "I would identify the read-after-write path and keep that session's reads on the primary for a window at least as long as the replica lag, or return a version boundary from the write and have the read wait until a replica reaches it. The rest of the read traffic stays on replicas. The window is simpler but needs session affinity and a lag estimate; the version boundary is precise but needs the position to travel with the request. I would also consider a write-through cache for the profile object if the read is a simple key lookup, but I would not use it for list or join queries that the cache cannot cover.",
    followUps: [
      "What if the user opens a second device?",
      "How would you handle a replica that never catches up?",
      "What would you measure to tune the window?",
    ],
    redFlags: [
      "Sends all reads to the primary.",
      "Uses a fixed window without measuring lag.",
      "Forgets session affinity.",
    ],
    rubric: [
      "Scopes the guarantee to read-after-write paths.",
      "Names a window or version boundary.",
      "Keeps other reads on replicas.",
      "Plans for lag and affinity.",
    ],
  },
  {
    id: "window-vs-token",
    question: "When would you choose a version boundary over a post-write primary window?",
    difficulty: 3,
    hints: [
      "One is time-based and one is position-based.",
      "Think about a replica that is unusually slow.",
    ],
    answer:
      "I would choose a version boundary when the read must reflect the exact write and the lag is variable or hard to bound. The write returns a log sequence number, transaction ID, or application version; the read asks a replica to wait until it has reached that position, and falls back to the primary on timeout. A time window is easier to add and works well when the lag distribution is stable and a small delay is acceptable. The boundary avoids sending every post-write read to the primary just because one replica is slow, but it requires driver or proxy support and a clear timeout policy.",
    followUps: [
      "What does the client do if the replica times out?",
      "How would you expose the position to the client?",
      "Why not use the primary for every read?",
    ],
    redFlags: [
      "Uses a fixed window for unbounded lag.",
      "Adds a token without a timeout path.",
      "Assumes all replicas are equally current.",
    ],
    rubric: [
      "Contrasts time and position.",
      "Names a fallback.",
      "Explains variable lag.",
      "Keeps the writer cost bounded.",
    ],
  },
  {
    id: "reader-endpoint-pinning",
    question: "How can a connection pool make stale reads worse even when the reader endpoint is healthy?",
    difficulty: 2,
    hints: [
      "The endpoint balances connections.",
      "A pool holds connections open.",
    ],
    answer:
      "The reader endpoint balances new connections across the replicas. A pool opens a small number of long-lived connections and keeps them, so each pool is pinned to whichever replica it reached first. If that replica falls behind, the pool keeps serving stale reads even though the other replicas are current. The fix is to check per-replica lag and connection distribution, recycle pools when a replica lags, or use a proxy or client-side balancing that can move connections. Reconnecting more often has its own cost in connection churn and warm-up.",
    followUps: [
      "How would you detect the pinning?",
      "Would more frequent reconnects always help?",
      "What does RDS Proxy change?",
    ],
    redFlags: [
      "Assumes the reader endpoint balances every query.",
      "Looks only at the cluster average lag.",
      "Reconnects on every query without considering cost.",
    ],
    rubric: [
      "Explains connection-level balancing.",
      "Names per-replica lag.",
      "Suggests pool recycling or proxy.",
      "Notes reconnect cost.",
    ],
  },
  {
    id: "cache-choice",
    question: "When is a write-through cache the right answer for read-after-write, and when is it a trap?",
    difficulty: 3,
    hints: [
      "It helps reads of the object just written.",
      "It does not make arbitrary queries consistent.",
    ],
    answer:
      "A write-through cache is a good fit when the read-after-write is a simple key lookup of the object that was just updated, such as a profile or settings record. The write updates the database and the cache together, so the next read can be served from the cache. It is a trap when the read is a list, join, or aggregate that the cache cannot represent, or when invalidation can fail and leave a stale entry longer than the replica would have been stale. I would treat the cache as another consistency mechanism with its own failure modes, not as a transparent read accelerator.",
    followUps: [
      "What happens if the cache write fails after the database commit?",
      "How would you invalidate a list query?",
      "How does cache TTL interact with replica lag?",
    ],
    redFlags: [
      "Uses a cache for every query shape.",
      "Ignores partial failure between database and cache.",
      "Assumes a TTL is a consistency guarantee.",
    ],
    rubric: [
      "Names the key-lookup case.",
      "Names list and join limits.",
      "Considers partial failure.",
      "Treats cache as a consistency choice.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Read paths are classified by whether they need read-your-writes.",
      "The post-write window is set from measured lag, not a round number.",
      "Session affinity is present wherever the window policy runs.",
      "Per-replica lag and connection distribution are visible.",
      "A version-boundary or primary fallback exists for paths that cannot tolerate staleness.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm that the stale value follows a write in the same session.",
      "Compare the window with the lag of the replica that served the read.",
      "Check whether a pool is pinned to one replica.",
      "Move only the affected read path; do not send all reads to the primary by default.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record which read paths needed freshness and which did not.",
      "Retune the window or add a version boundary where precision matters.",
      "Check writer load after the freshness change.",
      "Add a regression test for save-then-read on the affected screen.",
    ],
  },
];

const references = [
  {
    title: "Reader endpoints for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Endpoints.Reader.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection-level balancing and the reader endpoint's behavior when no replicas exist.",
  },
  {
    title: "Working with DB instance read replicas",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Asynchronous replication and the staleness a read replica can serve.",
  },
  {
    title: "PostgreSQL: Log-Shipping Standby Servers",
    url: "https://www.postgresql.org/docs/current/warm-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Read-only queries on a standby and the replay position that makes a write visible.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-replica-routing": {
      model: routingModel,
      presets,
      instructions:
        "Start healthy. Apply No stickiness and read the stale share, then raise the post-write window above the lag. Apply Primary only to compare the writer cost, then run the experiment.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Lag, capacity, and the read-after-write share are teaching values, not provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-primary-replica-lag",
    "databases-read-after-write",
    "databases-read-replica-cold",
    "databases-rds-aurora-arch",
  ],
};
