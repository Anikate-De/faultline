import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITE_RATE = 150;
const READ_RATE = 3_000;
const PRIMARY_CAPACITY = 4_000;
const SESSION_WINDOW = 10;
const REPLICA_COUNT = 3;

const params = [
  {
    id: "replicationLag",
    label: "Replica apply lag",
    min: 10,
    max: 5_000,
    step: 10,
    value: 500,
    unit: "ms",
    group: "Replication",
    help: "Time for a write on the primary to become visible on an asynchronous replica.",
    format: "ms" as const,
  },
  {
    id: "replicaReadShare",
    label: "Reads sent to replicas",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Read path",
    help: "Share of reads routed to asynchronous replicas. Every replica read can be stale during the lag window.",
    format: "percent" as const,
  },
  {
    id: "stickiness",
    label: "Session affinity",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Read path",
    help: "Share of a user's reads pinned to the same replica. This protects read ordering, not freshness.",
    format: "percent" as const,
  },
  {
    id: "guarantee",
    label: "Required guarantee",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Product contract",
    help: "0 eventual, 1 monotonic reads, 2 read-your-writes, 3 strong read. Strong means a read must observe the latest completed write; formal linearizability also orders concurrent operations. This is the guarantee the product needs, not the one the path currently provides.",
    format: "count" as const,
  },
];

const GUARANTEE_NAMES = ["Eventual", "Monotonic reads", "Read-your-writes", "Strong read"];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  lagMs: number;
  lagSec: number;
  replicaShare: number;
  sticky: number;
  guarantee: number;
  primaryReadShare: number;
  primaryOps: number;
  primaryUtil: number;
  primaryP99: number;
  replicaP99: number;
  replicaUtil: number;
  staleShare: number;
  staleReadRate: number;
  violations: number;
  readP99: number;
}

function compute(p: Params): Computed {
  const lagMs = Math.max(1, num(p, "replicationLag", 500));
  const replicaShare = clamp(num(p, "replicaReadShare", 90) / 100);
  const sticky = clamp(num(p, "stickiness", 95) / 100);
  const guarantee = Math.round(clamp(num(p, "guarantee", 0), 0, 3));
  const lagSec = lagMs / 1_000;
  const primaryReadShare = 1 - replicaShare;
  const primaryOps = WRITE_RATE + READ_RATE * primaryReadShare;
  const primaryUtil = primaryOps / PRIMARY_CAPACITY;
  const primaryP99 =
    primaryUtil >= 1
      ? 500
      : Math.min(500, 2 + (25 * primaryUtil ** 5) / Math.max(0.05, 1 - primaryUtil));
  const replicaUtil = (READ_RATE * replicaShare) / REPLICA_COUNT / 2_000;
  const replicaP99 =
    replicaUtil >= 1 ? 500 : Math.min(500, 2 + (15 * replicaUtil ** 4) / Math.max(0.05, 1 - replicaUtil));
  const staleShare = Math.min(1, lagSec / SESSION_WINDOW);
  const staleReadRate = replicaShare * staleShare * 100;
  const violationShare = [0, replicaShare * (1 - sticky) * 0.33, replicaShare * staleShare, replicaShare][guarantee];
  return {
    lagMs,
    lagSec,
    replicaShare,
    sticky,
    guarantee,
    primaryReadShare,
    primaryOps,
    primaryUtil,
    primaryP99,
    replicaP99,
    replicaUtil,
    staleShare,
    staleReadRate,
    violations: violationShare * 100,
    readP99: Math.max(primaryP99, replicaP99),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.6);
  const seeds: [string, number, number][] = [
    ["guarantee-violations", values.violations, 0.1],
    ["read-p99", values.readP99, 0.2],
    ["stale-read-rate", values.staleReadRate, 0.2],
    ["replication-lag", values.lagMs, 2],
    ["primary-read-share", values.primaryReadShare * 100, 0.3],
    ["primary-util", values.primaryUtil * 100, 0.4],
    ["replica-util", values.replicaUtil * 100, 0.4],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const violationsHealth = healthFor(values.violations, 0.5, 2);
  const primaryHealth = healthFor(values.primaryUtil * 100, 70, 85);
  const replicaHealth: "ok" | "warn" | "crit" =
    values.staleShare >= 0.2 && values.replicaShare >= 0.5
      ? values.guarantee >= 2
        ? "crit"
        : "warn"
      : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "writes then reads",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Profile service",
        kind: "service",
        health: violationsHealth,
        sublabel: `${GUARANTEE_NAMES[values.guarantee]} required`,
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Primary",
        kind: "db",
        role: "primary",
        health: primaryHealth,
        utilization: clamp(values.primaryUtil),
        sublabel: `${Math.round(values.primaryReadShare * 100)}% of reads`,
        detail: `Serves ${Math.round(values.primaryOps).toLocaleString()} ops/s. Primary p99 ${values.primaryP99.toFixed(0)}ms.`,
        meta: { view: "replication", lag: 0 },
      },
      ...Array.from({ length: REPLICA_COUNT }, (_, index) => {
        const lag = (values.lagMs / 1_000) * [0.6, 1, 1.5][index];
        return {
          id: `replica-${index}`,
          label: `Replica ${index + 1}`,
          kind: "db" as const,
          role: "replica" as const,
          health: replicaHealth,
          utilization: clamp(values.replicaUtil),
          sublabel: `lag ${lag.toFixed(2)}s`,
          detail: `Asynchronous replica, apply lag ${(lag * 1_000).toFixed(0)}ms. Reads routed here cannot promise more than the replica has applied.`,
          meta: { view: "replication", lag },
        };
      }),
    ],
    edges: [
      edge("service-primary", "service", "primary", values.primaryReadShare, primaryHealth),
      ...Array.from({ length: REPLICA_COUNT }, (_, index) =>
        edge(`service-replica-${index}`, "service", `replica-${index}`, values.replicaShare / REPLICA_COUNT, replicaHealth),
      ),
    ],
    metrics: [
      metric("guarantee-violations", "Reads outside the guarantee", values.violations, "%", 0.5, 2, "percent"),
      metric("read-p99", "Read p99", values.readP99, "ms", 100, 250, "ms"),
      metric("stale-read-rate", "Stale replica reads", values.staleReadRate, "%", undefined, undefined, "percent"),
      metric("replication-lag", "Replication lag", values.lagMs, "ms", 1_000, 2_500, "ms"),
      metric("primary-read-share", "Primary read share", values.primaryReadShare * 100, "%", undefined, undefined, "percent"),
      metric("primary-util", "Primary utilization", values.primaryUtil * 100, "%", 70, 85, "percent"),
      metric("replica-util", "Replica utilization", values.replicaUtil * 100, "%", 75, 90, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      guarantee: values.guarantee,
      paramsKey: JSON.stringify(p),
    },
    summary: `${GUARANTEE_NAMES[values.guarantee]} required; ${values.violations.toFixed(1)}% of reads are outside the guarantee; replica lag ${values.lagSec.toFixed(2)}s.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "guarantee-violations",
    metricId: "guarantee-violations",
    warn: 0.5,
    crit: 2,
    title: "Reads are outside the required consistency guarantee",
    cause:
      "The read path sends traffic to asynchronous replicas that cannot prove they have applied every completed write. For a strong read, every replica read is outside the guarantee even if that replica happens to be current; the path has no freshness check.",
    fix: "Either route the reads that need the promise to the primary or a consensus read path, or weaken the product requirement. Adding replicas does not give an asynchronous replica a freshness proof.",
    checkFirst: [
      "Confirm which guarantee the user experience actually needs.",
      "Compare replication lag with the read routing share.",
      "Check whether session affinity changed during the incident.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 100,
    crit: 250,
    title: "Read latency breached the SLO",
    cause:
      "Moving reads to the primary protects freshness but concentrates load on one node. Primary CPU and queueing rise together.",
    fix: "Restore read capacity on the primary or move only the freshness-sensitive reads. Do not move every read to the primary and call it a consistency fix.",
    checkFirst: [
      "Compare primary utilization with the primary read share.",
      "Check whether the replica path is healthy but unused.",
      "Check for retries against the primary.",
    ],
  },
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 1_000,
    crit: 2_500,
    title: "Replication lag exceeds the freshness budget",
    cause:
      "The primary is applying writes faster than a replica can fetch and replay them, or the network between them is slow.",
    fix: "Reduce write pressure, increase replica capacity, or keep freshness-sensitive reads off that replica. Lag is a property of the copy, not a read-side cache setting.",
    checkFirst: [
      "Check lag per replica, not the fleet average.",
      "Check write rate and replica CPU or network.",
      "Check whether a single replica is consistently behind.",
    ],
  },
  {
    id: "primary-util",
    metricId: "primary-util",
    warn: 70,
    crit: 85,
    title: "Primary utilization is approaching saturation",
    cause:
      "Freshness-sensitive reads have been concentrated on the primary while writes continue. The primary is now the queueing point.",
    fix: "Keep only reads that truly need the primary on it, add capacity, or relax the guarantee where the product allows.",
    checkFirst: [
      "Check primary ops by read and write.",
      "Check primary p99 and queue depth.",
      "Check whether a stronger guarantee was enabled without a capacity change.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function formatMode(mode: number): string {
  return GUARANTEE_NAMES[mode] ?? "Eventual";
}

export const consistencyModel: SimModel = {
  id: "foundations-consistency-models",
  visual: "replication",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    }
    const jitter = rng.between(-0.05, 0.05);
    next.metrics = next.metrics.map((item) =>
      item.id === "read-p99"
        ? { ...item, value: Math.max(0, item.value + jitter) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.violations >= 2 && frame.flags.mismatch !== 1) {
      pushEvent(next, {
        id: "consistency-mismatch",
        at: frame.t,
        severity: "crit",
        title: "The read path is outside the guarantee",
        detail: `${formatMode(values.guarantee)} was selected, but ${Math.round(values.replicaShare * 100)}% of reads go to replicas with ${values.lagSec.toFixed(2)}s lag. About ${values.violations.toFixed(1)}% of reads are therefore outside the guarantee. For strong reads this counts the routing risk, not only the reads that happen to be stale.`,
        nodeId: "service",
        metricId: "guarantee-violations",
      });
      next.flags.mismatch = 1;
    }
    if (values.violations < 0.5) next.flags.mismatch = 0;
    next.flags.paramsKey = key;
    next.summary = `${formatMode(values.guarantee)} required; ${values.violations.toFixed(1)}% of reads are outside the guarantee; replica lag ${values.lagSec.toFixed(2)}s.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `${formatMode(values.guarantee)} is required. With ${Math.round(values.replicaShare * 100)}% of reads on replicas, ${values.violations.toFixed(1)}% of reads are outside the guarantee.`,
      `${Math.round(values.staleReadRate)}% of all reads are stale by up to ${values.lagSec.toFixed(2)}s. Being outside the guarantee can be a routing risk even when the replica happens to be current: the path cannot prove freshness.`,
      `${Math.round(values.primaryReadShare * 100)}% of reads hit the primary at ${(values.primaryUtil * 100).toFixed(0)}% utilization; its p99 is ${values.primaryP99.toFixed(0)}ms.`,
    ];
    if (values.guarantee === 1) {
      items.push(
        `Monotonic reads are protected by session affinity, which is ${Math.round(values.sticky * 100)}% here. Affinity protects ordering; it does not make a replica fresher.`,
      );
    }
    if (values.guarantee >= 2) {
      items.push(
        "Read-your-writes and strong reads need the write to be visible on the node that serves the read. Asynchronous replication cannot provide that for free.",
      );
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
    description: "Eventual reads on caching replicas with modest lag.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Monotonic reads at high traffic; session affinity mostly holds.",
    tone: "warn",
    params: defaults({ replicationLag: 800, replicaReadShare: 80, stickiness: 95, guarantee: 1 }),
  },
  {
    id: "failure",
    label: "Strong read on replicas",
    description: "A profile page requires strong reads but the service still sends 85% to async replicas.",
    tone: "crit",
    params: defaults({ replicationLag: 2_500, replicaReadShare: 85, stickiness: 50, guarantee: 3 }),
  },
  {
    id: "recovery",
    label: "Weaken and pin",
    description: "Use read-your-writes, cut lag, and send 60% of reads to the primary.",
    tone: "ok",
    params: defaults({ replicationLag: 100, replicaReadShare: 40, stickiness: 95, guarantee: 2 }),
  },
  {
    id: "strong-primary",
    label: "Strong, primary only",
    description: "Keep strong reads and move every read to the primary; freshness costs headroom.",
    tone: "warn",
    params: defaults({ replicationLag: 100, replicaReadShare: 0, stickiness: 100, guarantee: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-guarantee",
  title: "Predict which change removes the reads outside the guarantee",
  simId: "consistency",
  question:
    "A profile page requires strong reads, but 85% of reads go to replicas with 2.5s lag. Which single change removes the reads outside the guarantee?",
  prediction: {
    options: [
      { id: "primary", label: "Serve the reads that need the guarantee from the primary" },
      { id: "lag", label: "Reduce replica lag to 100ms" },
      { id: "replicas", label: "Add a fourth asynchronous replica" },
      { id: "retry", label: "Retry the read until a fresh value appears" },
    ],
    correctOptionId: "primary",
    explanation:
      "A strong read requires a node that can prove it has applied every completed write. An asynchronous replica is behind by design, and a smaller lag still leaves a window. Even a replica that happens to be current cannot prove freshness without a version or position check. Retrying does not create that proof and can add load. Serving those reads from the primary, or from a consensus read path, is the direct fix.",
  },
  setup: defaults({ replicationLag: 2_500, replicaReadShare: 85, stickiness: 50, guarantee: 3 }),
  runFor: 20,
  observe: [
    "Reads outside the guarantee stay near 85% even when replica lag is reduced, because the routing risk remains.",
    "Stale replica reads remain a large share because most reads never touch the primary.",
    "Primary utilization is low in the failure state, which shows the unused capacity.",
    "Moving reads to the primary removes the reads outside the guarantee and raises primary utilization.",
  ],
  explain:
    "A guarantee is a property of the read path, not a label. Eventual consistency permits stale reads. Monotonic reads forbid going backwards in time but permit an old value. Read-your-writes constrains the writer's own later reads. A strong read requires the latest completed write; formal linearizability is stronger still because it also orders concurrent operations. Asynchronous replicas can satisfy the first two cheaply; the last two require routing, quorum reads, or waiting.",
  fix: defaults({ replicationLag: 2_500, replicaReadShare: 0, stickiness: 100, guarantee: 3 }),
  debrief:
    "Serving every read from the primary removes the reads outside the guarantee and makes the cost visible: primary utilization rises from about 15% to about 79% at a fixed 3,000 reads/s and 150 writes/s. A real design would route only the freshness-sensitive reads, or relax the product promise for paths that can tolerate staleness.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A consistency model is a promise about what a read may return. Eventual consistency says a replica will converge, without saying when. Monotonic reads say a user will not move backwards to an older value. Read-your-writes says a user who wrote a value will see that value on later reads. A strong read says the read observes the latest completed write. Linearizability is the formal guarantee that also preserves real-time order across concurrent operations; this module models the freshness requirement, not a full linearizability proof.",
  },
  {
    type: "p",
    text: "These promises are not interchangeable. A profile page that says the update succeeded and then shows the old name is missing read-your-writes. A feed that jumps back to older posts after a refresh is missing monotonic reads. A cache that converges in a second may be perfectly correct for a view counter and unacceptable for a password change. The right model is the weakest one the product can defend.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "diagram",
    id: "replica-lag",
    caption:
      "A write lands on the primary and reaches replicas later. A read served by a replica sees the replica's applied state, not the primary's current state.",
  },
  {
    type: "p",
    text: "The request path is user, service, and then a read routing decision: primary or replica. The primary serializes writes and is the reference for freshness. Asynchronous replicas replay the write stream and serve reads at lower cost, with lag. Session affinity is a separate mechanism: it keeps one user on one replica so that reads are ordered, but it cannot make that replica fresher than its applied position.",
  },
  {
    type: "p",
    text: "This module models a profile service at a fixed 150 writes/s and 3,000 reads/s. Replica lag, the share of reads sent to replicas, and the share of sessions with affinity are the controls. The latency curve and the guarantee percentages are illustrative teaching values, not measurements from a specific database.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Reads outside the guarantee: the share of reads whose path cannot prove the selected promise.",
      "Stale replica reads: the share of all reads served by a copy that is behind, whether or not the product promised freshness.",
      "Replication lag and primary read share: the two levers behind most stale-read incidents.",
      "Primary utilization and read p99: the cost of moving reads to the freshness source.",
      "A replica view with lag per replica, because a fleet average hides the slow copy.",
    ],
  },
  {
    type: "table",
    headers: ["Model", "Promise", "Typical cost"],
    rows: [
      ["Eventual", "Replicas converge; reads may be stale", "Cheapest reads, visible staleness"],
      ["Monotonic reads", "A user's reads never go backwards", "Session affinity; uneven replica load"],
      ["Read-your-writes", "The writer sees its own update", "Pinning or waiting after a write"],
      ["Strong read", "Observes the latest completed write", "Primary or quorum reads; higher latency"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Strong read on replicas. Compare reads outside the guarantee with stale replica reads: they answer different questions. Reduce lag, then add session affinity, and watch that neither alone satisfies a strong read. Finally apply Weaken and pin, then Strong, primary only, and compare their primary utilization.",
  },
  { type: "sim", simId: "consistency" },
  { type: "experiment", experimentId: "predict-stale-guarantee" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write reached the primary immediately and the replicas later. Reads routed to a replica returned the replica's applied state, so a user could see a value older than the write that had just been acknowledged. The selected guarantee made that observable as reads outside the guarantee, not just as background staleness.",
  },
  {
    type: "p",
    text: "Reducing lag narrowed the stale window but did not remove it. Session affinity protected read ordering and did nothing for freshness. The reads outside the guarantee disappeared only when the reads that required the promise stopped using asynchronous replicas. That moved the cost to the primary, where utilization and p99 rose.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database metrics: replica lag per replica, apply rate, read and write ops on the primary, and primary CPU or queue depth.",
      "Application metrics: stale-read rate, read-your-writes failures, retry volume after a write, and reads by routing target.",
      "Traces: a write span completes, then the next read span is served by a replica whose applied timestamp is older than the write.",
      "Logs: an update response followed by a read of the old value for the same user or key, especially across a load-balancer switch.",
      "Client signals: a user refresh that appears to revert a change, or a duplicate form submission after the first response looked wrong.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Identify the user-visible promise, then the read routing for that path. Check lag per replica and whether the request was served by the primary or a replica. Only then decide whether to strengthen the path or weaken the promise.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name the guarantee the experience needs: eventual for counters, monotonic for feeds, read-your-writes for profile edits, strong for money and access control.",
      "Find which reads violate it and where they were routed. A single stale read is not enough evidence; measure the share.",
      "For read-your-writes, pin the writer's reads to the primary for a bounded window, or wait for the replica to reach the write's position.",
      "For monotonic reads, use session affinity or a version token that refuses to serve an older version.",
      "For strong reads, use the primary or a quorum read path. Keep the traffic that needs it small.",
      "Re-check primary utilization, p99, and replica lag after the change. Consistency work moves load; it does not delete it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Strong reads are the easiest to reason about and the most expensive to serve at scale: every read needs a fresh source or a quorum.",
      "Read-your-writes is cheaper but needs a per-user or per-key freshness marker, and it fails if the marker is lost across a session move.",
      "Monotonic reads protect ordering, not freshness; a user can stay consistently wrong on one replica.",
      "Eventual consistency is cheap and honest only when the product can tolerate an old value; it is not a synonym for incorrect.",
      "Weakening a promise is a product decision, not an infrastructure workaround. Write it down and test the experience against it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-ryw",
    question:
      "A user changes a display name, gets a success response, refreshes, and sees the old name. The database says the write committed and replica lag is 800ms. What is your diagnosis?",
    difficulty: 3,
    hints: [
      "The write committed, so the primary is not the problem.",
      "The refresh is a new read and may have gone to a different node.",
    ],
    answer:
      "The read path is missing read-your-writes. The write committed on the primary, but the refresh was served by an asynchronous replica that had not applied it yet, or by a different session that lost affinity. I would confirm the routing for the read and the replica's applied position. The fix is to pin the writer's post-write reads to the primary for a bounded window, wait for the replica to reach the write's log position, or return a version token that the read can validate. Shortening lag helps the window but does not remove the race.",
    followUps: [
      "How long would you pin the session, and what happens if the user changes devices?",
      "Would a cache in front of the primary change the diagnosis?",
      "How would you measure whether the fix worked?",
    ],
    redFlags: [
      "Says the write did not commit without checking the primary.",
      "Claims adding replicas fixes freshness.",
      "Treats a cache TTL as a consistency guarantee.",
    ],
    rubric: [
      "Separates write success from read freshness.",
      "Identifies routing or replica position as the cause.",
      "Proposes a bounded, testable fix.",
      "Names the measurement.",
    ],
  },
  {
    id: "choose-model",
    question:
      "How do you choose between eventual, monotonic, read-your-writes, and strong consistency for a new feature?",
    difficulty: 3,
    hints: [
      "Start from the user-visible failure, not the database feature list.",
      "The weakest model that prevents the failure is usually the cheapest.",
    ],
    answer:
      "I start from what the user must never see. A view counter can be eventual. A feed where a refresh must not jump backwards needs monotonic reads. A settings page where a save must appear immediately needs read-your-writes. Money, permissions, and inventory reservations usually need strong reads or a serialized path. Then I check the cost: replica reads are cheap, primary or quorum reads add latency and concentrate load, and session affinity adds routing constraints. I would choose the weakest model that prevents the user-visible failure and write the promise down.",
    followUps: [
      "Where would you allow two models in one product?",
      "How do you test a consistency promise before launch?",
      "What would make you revisit the choice?",
    ],
    redFlags: [
      "Picks strong consistency for everything.",
      "Confuses cache freshness with a consistency model.",
      "Cannot name the user-visible failure.",
    ],
    rubric: [
      "Starts from user-visible failures.",
      "Maps each model to a concrete experience.",
      "Names the cost of the stronger model.",
      "Records the decision.",
    ],
  },
  {
    id: "monotonic-affinity",
    question:
      "A load balancer moves a user between two replicas and the user sees an older value on the second read. Which guarantee failed, and why does session affinity help?",
    difficulty: 2,
    hints: [
      "The value moved backwards, not just stale.",
      "The two replicas applied different amounts of the stream.",
    ],
    answer:
      "Monotonic reads failed: the second read observed an older state than the first. Session affinity helps because it keeps the user's reads on the same replica, whose applied position only moves forward. It does not make that replica current, so it is not a substitute for read-your-writes. If affinity is lost during a deploy or failover, a version or timestamp check is needed to prevent the read from going backwards.",
    followUps: [
      "What happens to affinity during a rolling deploy?",
      "How would you implement a monotonic read without affinity?",
      "Does a read from the primary always satisfy monotonic reads?",
    ],
    redFlags: [
      "Calls it eventual consistency and stops.",
      "Believes affinity guarantees fresh data.",
      "Ignores session migration.",
    ],
    rubric: [
      "Names monotonic reads.",
      "Explains forward-only replica position.",
      "Separates ordering from freshness.",
      "Mentions failover or version checks.",
    ],
  },
  {
    id: "strong-cost",
    question:
      "Your service needs strong reads on 5% of traffic. The primary is already at 70% utilization. How do you add the guarantee without taking down the primary?",
    difficulty: 4,
    hints: [
      "Do not move all reads to protect 5%.",
      "Think about a separate read path or a bounded consistency window.",
    ],
    answer:
      "I would isolate the 5% that needs strong reads and route only those to the primary or a quorum path, with a separate concurrency limit so they cannot crowd out writes. I would check whether some of that 5% can use read-your-writes instead, which is cheaper. If the primary does not have headroom, I would add a dedicated strong-read replica fed synchronously, or move the guarantee to a smaller data set. The key is to avoid turning a consistency requirement into an unbounded primary read load.",
    followUps: [
      "How would you bound the strong-read path?",
      "What happens when the primary is unavailable?",
      "Which SLO would you put on the strong path?",
    ],
    redFlags: [
      "Sends all reads to the primary.",
      "Assumes the primary has infinite headroom.",
      "Uses an async replica and calls it strong.",
    ],
    rubric: [
      "Isolates the traffic that needs the guarantee.",
      "Bounds concurrency on the primary path.",
      "Considers a cheaper model for the rest.",
      "Names the failure mode.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every read path has a written consistency promise and a named owner.",
      "Dashboards show replica lag per replica, read routing share, and primary utilization.",
      "Session affinity behavior during deploys and failover is tested.",
      "Read-your-writes paths have a version or position check.",
      "Strong-read traffic is bounded by a concurrency limit.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the write succeeded before blaming the write path.",
      "Find out which node served the read and how far it had applied.",
      "Separate stale reads that are allowed from reads that break the promise.",
      "Prefer routing the sensitive reads to a fresh source over shortening every TTL.",
      "Watch primary utilization when you shift reads toward it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test for the user-visible promise, not just the database.",
      "Document the guarantee and its cost next to the feature.",
      "Revisit whether the promise was stronger than the product needed.",
      "Check that monitoring would catch the next read outside the guarantee before a user does.",
    ],
  },
];

const references = [
  {
    title: "Consistency models",
    url: "https://jepsen.io/consistency",
    publisher: "Jepsen",
    kind: "docs" as const,
    note: "A map of consistency models and their formal relationships.",
  },
  {
    title: "Linearizable consistency",
    url: "https://jepsen.io/consistency/models/linearizable",
    publisher: "Jepsen",
    kind: "docs" as const,
    note: "The formal linearizability definition and its real-time ordering requirement.",
  },
  {
    title: "DynamoDB read consistency",
    url: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Eventually consistent and strongly consistent reads in a managed store.",
  },
  {
    title: "Cloud Storage consistency",
    url: "https://cloud.google.com/storage/docs/consistency",
    publisher: "Google Cloud",
    kind: "docs" as const,
    note: "Strong read-after-write and list consistency in a managed object store.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    consistency: {
      model: consistencyModel,
      presets,
      instructions:
        "Start healthy, then require strong reads while most traffic still goes to replicas. Compare stale reads with reads outside the guarantee, then move the sensitive reads to the primary and watch the cost.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Fixed 150 writes/s and 3,000 reads/s; latency and guarantee percentages are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-cap-pacelc",
    "foundations-caching-strategies",
    "foundations-cache-invalidation",
  ],
};
