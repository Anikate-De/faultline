import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const READ_AFTER_WRITE_SHARE = 0.25;
const WRITE_SHARE = 0.1;
const REPLICA_CAPACITY = 3_600;

const params = [
  {
    id: "policy",
    label: "Read policy (0 replica, 1 sticky, 2 token, 3 primary)",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Routing",
    help: "0 sends every read to a replica. 1 sends reads to the primary for a post-write window. 2 waits for the replica to reach a version token. 3 sends every read to the primary.",
    format: "count" as const,
  },
  {
    id: "replicaLagMs",
    label: "Replica lag",
    min: 0,
    max: 5_000,
    step: 50,
    value: 250,
    unit: " ms",
    group: "Replica",
    help: "How far the replica is behind the primary's commit point. A read can see a write only after replay reaches it.",
    format: "ms" as const,
  },
  {
    id: "stickyWindowMs",
    label: "Post-write primary window",
    min: 0,
    max: 10_000,
    step: 100,
    value: 1_000,
    unit: " ms",
    group: "Sticky policy",
    help: "After a write, route this session's reads to the primary for this long. It applies only to policy 1.",
    format: "ms" as const,
  },
  {
    id: "readRate",
    label: "Read traffic",
    min: 100,
    max: 5_000,
    step: 100,
    value: 2_000,
    unit: " reads/s",
    group: "Traffic",
    help: "Total read traffic. The model treats about 25% of reads as following a recent write in the same session.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  policy: number;
  lag: number;
  sticky: number;
  readRate: number;
  affected: number;
  stickyCoverage: number;
  staleShare: number;
  staleReads: number;
  primaryReads: number;
  replicaReads: number;
  readWait: number;
  replicaLoad: number;
  sessionHealth: Health;
  routerHealth: Health;
  primaryHealth: Health;
  replicaHealth: Health;
}

function compute(p: Params): Computed {
  const policy = clamp(Math.round(num(p, "policy", 1)), 0, 3);
  const lag = clamp(num(p, "replicaLagMs", 250), 0, 5_000);
  const sticky = clamp(num(p, "stickyWindowMs", 1_000), 0, 10_000);
  const readRate = clamp(num(p, "readRate", 2_000), 100, 5_000);
  const affected = readRate * READ_AFTER_WRITE_SHARE;
  const stickyCoverage = lag <= 0 ? 1 : clamp(sticky / lag, 0, 1);
  const staleShare =
    policy === 0
      ? lag > 0
        ? READ_AFTER_WRITE_SHARE * 100
        : 0
      : policy === 1
        ? lag > 0
          ? READ_AFTER_WRITE_SHARE * 100 * (1 - stickyCoverage)
          : 0
        : 0;
  const staleReads = readRate * (staleShare / 100);
  const primaryReads =
    policy === 1 && lag > 0 ? affected * stickyCoverage : policy === 3 ? readRate : 0;
  const replicaReads = Math.max(0, readRate - primaryReads);
  const readWait = policy === 2 ? lag : 0;
  const replicaLoad = Math.max(0, (replicaReads / REPLICA_CAPACITY) * 100);
  const sessionHealth: Health = staleShare >= 2 ? "crit" : staleShare >= 0.5 ? "warn" : "ok";
  const routerHealth: Health = readWait >= 2_500 ? "crit" : readWait >= 1_000 ? "warn" : "ok";
  const primaryHealth: Health = primaryReads >= 4_000 ? "crit" : primaryReads >= 2_500 ? "warn" : "ok";
  const replicaHealth: Health = replicaLoad >= 95 ? "crit" : replicaLoad >= 80 ? "warn" : "ok";
  return {
    policy,
    lag,
    sticky,
    readRate,
    affected,
    stickyCoverage,
    staleShare,
    staleReads,
    primaryReads,
    replicaReads,
    readWait,
    replicaLoad,
    sessionHealth,
    routerHealth,
    primaryHealth,
    replicaHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMs(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function policyName(policy: number): string {
  return ["replica-first", "sticky window", "version token", "primary-only"][policy] ?? "sticky window";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["stale-share", values.staleShare, 0.1],
    ["stale-reads", values.staleReads, 2],
    ["primary-reads", values.primaryReads, 3],
    ["read-wait", values.readWait, 2],
    ["replica-load", values.replicaLoad, 0.3],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      value <= 0 ? 0 : Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, flags: SimFrame["flags"] = {}): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "session",
        label: "User session",
        kind: "client",
        health: values.sessionHealth,
        utilization: clamp(values.staleShare / 25),
        sublabel: `${formatCount(values.readRate)} reads/s · ${policyName(values.policy)}`,
        detail: `About ${Math.round(
          READ_AFTER_WRITE_SHARE * 100,
        )}% of reads are modeled as read-after-write. Those are the reads that need a consistency decision; the rest can tolerate a replica.`,
        meta: { view: "flow" },
      },
      {
        id: "router",
        label: "Read router",
        kind: "mesh",
        health: values.routerHealth,
        utilization: clamp(values.stickyCoverage),
        sublabel: `${formatMs(values.sticky)} sticky · ${formatMs(values.lag)} lag`,
        detail: "The router decides per read or per session. A sticky window needs the application to know when the write happened; a version token needs the replica to prove it has reached that version.",
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Primary",
        kind: "db",
        role: "primary",
        health: values.primaryHealth,
        utilization: clamp(values.primaryReads / 5_000),
        sublabel: `${formatCount(values.primaryReads)} reads/s · ${formatCount(values.readRate * WRITE_SHARE)} writes/s`,
        detail: "The primary always has the user's write. Reading here is the simplest correctness fix and the most expensive one when every read uses it.",
        meta: { view: "flow" },
      },
      {
        id: "replica",
        label: "Read replica",
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: clamp(values.replicaLoad / 100),
        sublabel: `${formatCount(values.replicaReads)} reads/s · ${formatMs(values.lag)} behind`,
        detail: "The replica is eventually consistent. A read that arrives before replay reaches the write's commit point returns the previous value, even though the write is durable on the primary.",
        meta: { view: "flow", lag: values.lag / 1_000 },
      },
    ],
    edges: [
      edge("session-router", "session", "router", 1, values.sessionHealth, "read"),
      edge(
        "router-primary",
        "router",
        "primary",
        clamp(values.primaryReads / Math.max(1, values.readRate)),
        values.primaryHealth,
        "fresh read",
      ),
      edge(
        "router-replica",
        "router",
        "replica",
        clamp(values.replicaReads / Math.max(1, values.readRate)),
        values.replicaHealth,
        "replica read",
      ),
    ],
    metrics: [
      metric("stale-share", "Stale read share", values.staleShare, "%", 0.5, 2, "percent"),
      metric("stale-reads", "Stale reads", values.staleReads, " reads/s", 50, 300, "rps"),
      metric("primary-reads", "Primary reads", values.primaryReads, " reads/s", 2_500, 4_000, "rps"),
      metric("read-wait", "Version wait", values.readWait, "ms", 1_000, 2_500, "ms"),
      metric("replica-load", "Replica load", values.replicaLoad, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { ...flags, seed },
    summary: `${policyName(values.policy)}: ${values.staleShare.toFixed(1)}% stale reads (${formatCount(
      values.staleReads,
    )}/s); ${formatCount(values.primaryReads)} primary reads/s; version wait ${formatMs(
      values.readWait,
    )}; replica ${Math.round(values.replicaLoad)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-share",
    metricId: "stale-share",
    warn: 0.5,
    crit: 2,
    title: "A read-after-write is landing on a stale replica",
    cause:
      "The read reached a replica before replay caught up with the write. The write is committed on the primary; the replica is serving an earlier snapshot. A longer sticky window or a version boundary is missing.",
    fix:
      "Route the session's reads to the primary for at least the observed lag, pass a version token and wait for the replica to reach it, or read the written object from the primary or a write-through cache.",
    checkFirst: [
      "Check the write's commit time against the replica's replay position.",
      "Check whether the sticky window is shorter than the replica lag.",
      "Check whether a cache is serving an older value after the replica has caught up.",
    ],
  },
  {
    id: "stale-reads",
    metricId: "stale-reads",
    warn: 50,
    crit: 300,
    title: "Stale reads are reaching users at a material rate",
    cause:
      "A stale-read share matters only at volume. The same routing gap that affects one refresh can affect every read-after-write request in the fleet.",
    fix:
      "Scope the consistency policy to read-after-write paths instead of all reads, and send only those reads to a consistent source. Measure the affected request volume before widening the policy.",
    checkFirst: [
      "Check which endpoints produce the stale reads, not just the fleet total.",
      "Check whether the read is in the same session as the write.",
      "Check whether the read is a retry that arrived after the first response.",
    ],
  },
  {
    id: "primary-reads",
    metricId: "primary-reads",
    warn: 2_500,
    crit: 4_000,
    title: "The consistency policy is moving too much read traffic to the primary",
    cause:
      "A sticky window that is longer than the lag, or a primary-only policy, sends reads to the writer that could have been served by replicas. The correctness fix becomes a capacity problem.",
    fix:
      "Shorten the sticky window to the measured lag, use a version token so only the affected reads wait, and keep primary-only reads for the paths that truly need them.",
    checkFirst: [
      "Compare the sticky window with the lag distribution, not the average.",
      "Check whether every read is being treated as read-after-write.",
      "Check primary CPU, connections, and read latency together.",
    ],
  },
  {
    id: "read-wait",
    metricId: "read-wait",
    warn: 1_000,
    crit: 2_500,
    title: "Version-token reads are waiting too long for the replica",
    cause:
      "The token is correct, but the replica is far enough behind that waiting for it costs more than the read is worth. A token does not make replication faster.",
    fix:
      "Read from the primary when the replica is behind the token by more than the request budget, or reduce replica lag. Keep the wait bounded and return a deliberate fallback rather than an unbounded stall.",
    checkFirst: [
      "Compare the token wait with the request's latency budget.",
      "Check whether one lagging replica is receiving the read.",
      "Check whether the write's version is newer than the replica's replay point.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const readAfterWriteModel: SimModel = {
  id: "databases-read-after-write",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.flags);
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];

    if (values.staleShare >= 0.5 && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "read-after-write-stale",
        at: frame.t,
        severity: values.staleShare >= 2 ? "crit" : "warn",
        title: "The user's own write is not visible on this read",
        detail: `${values.staleShare.toFixed(
          1,
        )}% of reads can arrive before the replica replays the write. The write is committed, but the page shows the previous value.`,
        nodeId: "replica",
        metricId: "stale-share",
      });
    }
    if (values.readWait >= 1_000 && frame.flags.waitLogged !== 1) {
      pushEvent(next, {
        id: "version-token-wait",
        at: frame.t,
        severity: values.readWait >= 2_500 ? "crit" : "warn",
        title: "The version token is waiting on replica replay",
        detail: `The read waits about ${formatMs(
          values.readWait,
        )} for the replica to reach the write's version. Correctness is preserved; latency is not.`,
        nodeId: "router",
        metricId: "read-wait",
      });
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      staleLogged: values.staleShare >= 0.5 ? 1 : 0,
      waitLogged: values.readWait >= 1_000 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The read policy is ${policyName(values.policy)}. About ${formatCount(
        values.affected,
      )} reads per second are modeled as read-after-write.`,
      values.staleShare > 0
        ? `${values.staleShare.toFixed(
            1,
          )}% of reads can be stale. That is a consistency gap, not a lost write.`
        : "No reads are stale in this state. The write is visible on the read path.",
    ];
    if (values.primaryReads > 0) {
      items.push(
        `${formatCount(values.primaryReads)} reads/s go to the primary for freshness. That is the capacity price of the policy.`,
      );
    }
    if (values.readWait > 0) {
      items.push(
        `A version-token read waits about ${formatMs(values.readWait)}. The wait is bounded by the replica's replay progress.`,
      );
    }
    items.push(
      "A cache adds another boundary: the replica can be current while the cache still serves a value from before the write.",
    );
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
    description: "A one-second sticky window covers 250ms of replica lag. Read-after-write traffic is fresh without sending every read to the primary.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Primary-only reads",
    description: "Every read goes to the primary at 3,200 reads/s. Correctness is easy; primary read capacity is the warning.",
    tone: "warn",
    params: defaults({ policy: 3, readRate: 3_200 }),
  },
  {
    id: "failure",
    label: "Replica-first reads",
    description: "A 1.2-second replica lag with no stickiness leaves 25% of reads stale. The write is committed; the page is not.",
    tone: "crit",
    params: defaults({ policy: 0, replicaLagMs: 1_200, readRate: 2_500 }),
  },
  {
    id: "recovery",
    label: "Version token",
    description: "The read waits for the replica to reach the write's version. No stale reads, with a 400ms bounded wait.",
    tone: "ok",
    params: defaults({ policy: 2, replicaLagMs: 400 }),
  },
  {
    id: "sticky-gap",
    label: "Sticky window too short",
    description: "A 200ms sticky window against 1.2 seconds of lag covers only part of the gap. About 21% of reads are still stale.",
    tone: "crit",
    params: defaults({ policy: 1, replicaLagMs: 1_200, stickyWindowMs: 200 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-read",
  title: "Predict what the user sees after saving",
  simId: "read-after-write",
  question:
    "A user saves a setting. The write commits on the primary, and the next page load reads a replica that is 1.2 seconds behind. What does the user see?",
  prediction: {
    options: [
      { id: "old-value", label: "The previous value, until the replica replays the write." },
      { id: "rolled-back", label: "The write is rolled back because the replica cannot see it." },
      { id: "lost", label: "The write is lost; the primary never committed it." },
      { id: "read-error", label: "The replica rejects the read because it is behind." },
    ],
    correctOptionId: "old-value",
    explanation:
      "The read is valid, but it runs against a replica at an earlier point in time. The write is committed on the primary and will become visible after replay. This is a stale read, not a lost write. The fix is to route that session's read to a consistent source or make it wait for a version boundary.",
  },
  setup: defaults({ policy: 0, replicaLagMs: 1_200, readRate: 2_000, stickyWindowMs: 1_000 }),
  runFor: 20,
  observe: [
    "Stale read share reaches 25% and crosses the critical threshold.",
    "The stale-read rate is about 500 reads per second.",
    "Primary reads are zero because every read is going to the replica.",
    "Version wait is zero because the replica-first policy does not wait.",
    "The write is still on the primary. The problem is the read path, not durability.",
  ],
  explain:
    "Read-after-write is a session guarantee, not a database-wide property. An asynchronous replica can be behind the primary's commit point, so a read that follows a write in the same session can legitimately see the old value. The application has to choose which reads need the guarantee: a sticky primary window, a version token, or a primary read for the affected object. Sending every read to the primary is correct but gives up replica capacity.",
  fix: defaults({ policy: 1, replicaLagMs: 1_200, stickyWindowMs: 1_200, readRate: 2_000 }),
  debrief:
    "A sticky window equal to the lag removes the stale reads and sends only the 500 read-after-write reads per second to the primary. The rest still use the replica. A version token is more surgical: it waits only when the replica is behind the specific version. Either way, the fix is a consistency boundary for the session, not a blanket return to the primary.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Read-after-write, also called read-your-writes, is a session guarantee: after a user's write commits, that user's later reads see the write. It is narrower than strong consistency. Other users can still see older data, and the guarantee usually applies only to the same session or the same object. A system can be eventually consistent overall and still provide read-after-write for the person who just saved a form.",
  },
  {
    type: "p",
    text: "The problem appears when reads go to an asynchronous replica. The primary commits the write, then replication carries it to the replica. Until replay reaches that commit point, a read on the replica returns the previous value. The write is not lost and the transaction was not rolled back; the read simply used an earlier snapshot. PostgreSQL hot standby documentation describes this directly: the standby is eventually consistent, and the same query can return different results on primary and standby.",
  },
  {
    type: "p",
    text: "There are three common fixes. A sticky window sends the session's reads to the primary for a period after the write, usually at least the observed lag. A version token carries the write's log sequence number or application version and makes the replica wait until it has replayed that version, or routes to the primary if it is too far behind. Primary-only reads are the simplest and most expensive: every read pays writer capacity. A write-through or invalidating cache is a fourth boundary, because a current replica does not help if the cache still holds the old value.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is user session, read router, primary or replica, and sometimes a cache. The router must know two things: whether this read belongs to a session that recently wrote, and how far the chosen replica has replayed. A load balancer that spreads every request independently cannot answer either question. The application has to carry the session identity or the version boundary through the request.",
  },
  {
    type: "compare",
    leftTitle: "Sticky primary window",
    rightTitle: "Version token",
    rows: [
      { label: "What it carries", left: "Time since the session's last write", right: "The write's version or replay position" },
      { label: "When it sends to primary", left: "For the whole window", right: "Only when the replica is behind the token" },
      { label: "Main risk", left: "Window shorter than the real lag", right: "Wait or fallback when a replica is far behind" },
      { label: "Best fit", left: "Simple session store with predictable lag", right: "Object-level reads that can prove freshness" },
      { label: "Capacity cost", left: "Every read in the window", right: "Only reads that cannot be served yet" },
    ],
  },
  {
    type: "p",
    text: "The policy must be scoped. Treating every read as read-after-write turns the replica fleet into decoration and puts the writer back on the hot path. Treating none of them as read-after-write produces the support ticket: the user saved the setting, refreshed, and saw the old value. The useful unit is the read path that follows a write, not the whole application.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stale read share and stale reads per second, which separate a correctness gap from a volume problem.",
      "Primary reads per second, the capacity price of the consistency policy.",
      "Version wait, the latency price of waiting for a replica to catch up.",
      "Replica load, which shows whether the freshness policy is still using replica capacity.",
      "The policy switch, so the same lag can be viewed through replica-first, sticky, token, and primary-only routing.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Replica-first reads and read the stale share before changing the lag. Switch to Version token to see staleness turn into a bounded wait. Then shorten the sticky window below the lag to see a partial fix. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Lag values, the 25% read-after-write share, the 10% write-to-read ratio, and the replica capacity are illustrative teaching values. Real lag depends on write volume, network distance, replay capacity, and the replica's own workload.",
  },
  { type: "sim", simId: "read-after-write" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write committed on the primary. The next read went to a replica 1.2 seconds behind, so it returned the previous value. That is 25% of reads in the model, or about 500 reads per second, all of them valid reads against an earlier snapshot. Nothing rolled back. The replica would have shown the new value after replay caught up.",
  },
  {
    type: "p",
    text: "A sticky window of 1.2 seconds removed the stale reads and sent only the 500 read-after-write reads per second to the primary. A 200ms window covered only part of the gap and left about 21% stale. A version token removed staleness without sending reads to the primary, but the affected reads waited about as long as the lag. The tradeoff is visibility versus wait versus writer capacity.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PostgreSQL: pg_stat_replication on the primary shows write_lag, flush_lag, and replay_lag; the replica exposes pg_last_wal_replay_lsn and pg_stat_wal_receiver.",
      "Amazon RDS: ReplicaLag for each replica. Aurora: AuroraReplicaLag, replica CPU and connections, and the reader endpoint's routing behavior.",
      "Application: a stale-read counter on read-after-write paths, session IDs, the write's version or timestamp, and the replica that served the read.",
      "Cache: hit rate, age, invalidation lag, and whether the cached object was written through or only invalidated after commit.",
      "Support: save-then-refresh reports, especially from users whose reads are load-balanced across replicas or Regions.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the primary for the write before assuming it was lost. Then compare the read's time with the replica's replay position. If the replica was current, check the cache and the session routing. A stale read and a lost write look the same to the user and require different fixes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Prove the write exists on the primary. Compare the write's timestamp or version with the replica's replay position. Do not start by replaying the write.",
      "Classify the read path: does it need the user's own write, or can it tolerate a replica? Apply the guarantee only where the product requires it.",
      "For a simple session store, use a sticky primary window at least as long as the measured lag. Measure the lag distribution, not just the average.",
      "For object-level reads, carry a version token and have the replica wait for that version or fall back to the primary. Bound the wait.",
      "If the cache is in front of the database, write through or invalidate it after commit. A current replica behind a stale cache still serves the old value.",
      "Watch primary read load after widening the policy. Correctness that saturates the writer is a new outage.",
      "Keep the guarantee scoped to the session or object. Do not make the whole application read from the primary because one form is stale.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A sticky window is simple but sends every read in the window to the primary, even reads that would have been fine on a replica.",
      "A version token is precise but requires plumbing a version through the request and bounding the wait.",
      "Primary-only reads are the easiest to reason about and the most expensive at scale.",
      "Longer windows reduce stale reads but increase writer load; shorter windows do the opposite.",
      "Caching reduces database reads but adds another place where the old value can survive after the replica has caught up.",
      "Stronger session guarantees do not give global consistency; other users can still see older data.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-raw",
    question:
      "A user saves a setting and the next page load shows the old value. How do you fix it without sending every read to the primary?",
    difficulty: 2,
    hints: [
      "First separate a stale read from a lost write.",
      "The guarantee is per session or per object, not for all traffic.",
    ],
    answer:
      "I would first confirm the write is on the primary and compare its commit position with the replica's replay position. If the write is there and the replica is behind, it is a stale read. Then I would apply a consistency boundary only to the read-after-write path. That can be a sticky primary window at least as long as the measured lag, a version token that makes the replica wait until it reaches the write's version, or a primary read for that object. I would keep the rest of the reads on replicas. If a cache sits in front of the database, I would also check whether it was written through or invalidated after commit.",
    followUps: [
      "How would you measure the right sticky window?",
      "What does the version token add over stickiness?",
      "How do you keep the guarantee from becoming global?",
    ],
    redFlags: [
      "Assumes the write was lost.",
      "Sends all reads to the primary.",
      "Ignores the cache.",
    ],
    rubric: [
      "Separates stale read from lost write.",
      "Scopes the guarantee to the session or object.",
      "Names sticky, token, or primary-read options.",
      "Checks cache invalidation.",
    ],
  },
  {
    id: "sticky-vs-token",
    question: "When would you use a sticky primary window instead of a version token?",
    difficulty: 3,
    hints: [
      "Compare what each one knows about the write.",
      "Consider the cost when the replica is current.",
    ],
    answer:
      "I would use a sticky window when the application already has a session and the writes are simple, the lag is predictable, and a short primary window is cheap. It needs no version plumbing, but every read in the window goes to the primary even if the replica is already current. I would use a version token when the read is object-level, when the lag is variable, or when the primary read cost matters. The token can prove whether the replica has the write and wait only when it does not. It is more precise but needs the write's version to be carried through the read path and a bounded wait or fallback.",
    followUps: [
      "What happens if the sticky window is shorter than the lag?",
      "How do you choose the token's wait budget?",
      "Which option is easier to reason about during an incident?",
    ],
    redFlags: [
      "Treats the two as equivalent.",
      "Uses an average lag for a fixed window.",
      "Adds a token without a fallback.",
    ],
    rubric: [
      "Matches sticky to simple session writes.",
      "Matches token to variable lag and object reads.",
      "Names the primary-read cost.",
      "Bounds the wait.",
    ],
  },
  {
    id: "debug-stale",
    question:
      "A user reports that a saved change disappeared. Walk through how you would determine whether this is a stale read, a lost write, or a cache problem.",
    difficulty: 3,
    hints: [
      "Check the primary first.",
      "A cache can be stale even after the replica is current.",
    ],
    answer:
      "I would get the user, object, and approximate save time, then query the primary for the write and its commit version. If the row is missing there, the write did not commit or went to a different database; that is a lost-write path. If it is present, I would compare the read's time with the replica's replay position. If the replica had already replayed the write, I would check the cache: whether the key was invalidated, whether the read used a cached value, and whether the cache write-through path succeeded. I would also check whether the session was routed to a different replica or Region. The fix follows the boundary that was violated, not the symptom.",
    followUps: [
      "What would you log to make the next report faster to diagnose?",
      "How do you prove the cache is the stale layer?",
      "What if the write is present on the primary but the client got a timeout?",
    ],
    redFlags: [
      "Starts by replaying the write.",
      "Checks only the replica.",
      "Ignores the cache after the replica is current.",
    ],
    rubric: [
      "Checks the primary first.",
      "Compares read time with replay position.",
      "Checks cache invalidation and write-through.",
      "Distinguishes the violated boundary.",
    ],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "Read paths are classified as read-after-write or staleness-tolerant.",
      "The replica lag distribution is measured, not just the average.",
      "The application can identify a session and the time of its last write, or carry a version token.",
      "Cache invalidation and write-through behavior are understood for the affected objects.",
      "The consistency policy has a bounded fallback when the replica is too far behind.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Check the primary for the write before assuming data loss.",
      "Compare the read time with the replica's replay position.",
      "Check whether the read was served by a cache or a different replica.",
      "Measure the stale-read rate and the primary read load before widening the policy.",
      "Record the session, object, write version, and serving replica.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Scope the fix to the read paths that need read-after-write.",
      "Re-measure the lag and adjust the sticky window or token budget.",
      "Add a stale-read metric and a save-then-refresh test.",
      "Verify the cache invalidation path independently of the replica.",
    ],
  },
];

const references = [
  {
    title: "Working with DB instance read replicas",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Asynchronous replication from the primary to read replicas and the stale-read tradeoff.",
  },
  {
    title: "PostgreSQL: Hot Standby",
    url: "https://www.postgresql.org/docs/current/hot-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Standby reads are eventually consistent and can return different results from the primary.",
  },
  {
    title: "PostgreSQL: pg_stat_replication",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Write, flush, and replay lag columns used to compare a read with the write's replay position.",
  },
  {
    title: "PostgreSQL: Recovery Information Functions",
    url: "https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-RECOVERY-INFO-TABLE",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "pg_last_wal_replay_lsn and related functions for checking replay progress on a standby.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-after-write": {
      model: readAfterWriteModel,
      presets,
      instructions:
        "Start healthy, then apply Replica-first reads. Compare the stale share with the primary read count, then switch to Version token and to a shorter sticky window.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Lag, read mix, replica capacity, and wait times are teaching inputs, not database limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-read-replica-routing",
    "databases-primary-replica-lag",
    "databases-cross-region-rpo",
    "databases-write-forwarding",
  ],
};
