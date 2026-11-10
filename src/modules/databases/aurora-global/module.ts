import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_BACKLOG_MB = 16_384;
const RPO_TARGET_S = 1;
const PROMOTION_BURST_S = 10;

const params = [
  {
    id: "writeRate",
    label: "Primary write rate",
    min: 500,
    max: 30_000,
    step: 500,
    value: 4_000,
    unit: " writes/s",
    group: "Primary Region",
    help: "Committed writes per second in the primary Region. Aurora ships storage changes, not SQL statements, to the secondary Regions.",
    format: "rps" as const,
  },
  {
    id: "writeSizeKb",
    label: "Redo per write",
    min: 1,
    max: 16,
    step: 1,
    value: 4,
    unit: " KB",
    group: "Primary Region",
    help: "Average redo generated per write. Large rows, index changes, and bulk updates increase it.",
    format: "number" as const,
  },
  {
    id: "linkBandwidth",
    label: "Cross-Region replication bandwidth",
    min: 10,
    max: 200,
    step: 5,
    value: 60,
    unit: " MB/s",
    group: "Replication",
    help: "Illustrative redo transfer capacity between Regions. Aurora Global Database uses dedicated replication infrastructure.",
    format: "number" as const,
  },
  {
    id: "secondaryReadShare",
    label: "Reads served locally",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Secondary Region",
    help: "Share of application reads served by the secondary cluster. They are local and read-only, and only as fresh as the replayed volume.",
    format: "percent" as const,
  },
  {
    id: "promote",
    label: "Promote secondary",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failover",
    help: "1 models promotion of the secondary cluster. The lag at promotion becomes the data-loss window; 0 keeps the primary as writer.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  writeRate: number;
  writeSizeKb: number;
  link: number;
  secondaryShare: number;
  promote: boolean;
  ingest: number;
  linkUtil: number;
  replayShortfall: number;
}

function compute(p: Params): Computed {
  const writeRate = Math.max(0, num(p, "writeRate", 4_000));
  const writeSizeKb = Math.max(0, num(p, "writeSizeKb", 4));
  const link = Math.max(0.1, num(p, "linkBandwidth", 60));
  const secondaryShare = clamp(num(p, "secondaryReadShare", 80), 0, 100);
  const promote = num(p, "promote", 0) >= 0.5;
  const ingest = (writeRate * writeSizeKb) / 1_024;
  return {
    writeRate,
    writeSizeKb,
    link,
    secondaryShare,
    promote,
    ingest,
    linkUtil: promote ? 0 : Math.min(300, (ingest / link) * 100),
    replayShortfall: promote ? 0 : Math.max(0, ingest - link),
  };
}

function healthFor(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function worstHealth(...states: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return states.reduce<Health>((worst, state) => (rank[state] > rank[worst] ? state : worst), "ok");
}

interface PromotionState {
  totalBacklogMb: number;
  promotedLag: number | null;
}

interface GlobalValues {
  lag: number;
  rpoOverrun: number;
  primaryHealth: Health;
  secondaryHealth: Health;
  localReadShare: number;
}

function globalValues(values: Computed, state: PromotionState): GlobalValues {
  const lag = values.promote
    ? state.promotedLag ?? 0.05
    : state.totalBacklogMb / Math.max(values.ingest, 0.1) + 0.05;
  const rpoOverrun = Math.max(0, lag - RPO_TARGET_S);
  const lagHealth = healthFor(lag, 1, 5);
  const linkHealth = healthFor(values.linkUtil, 90, 120);
  const localReadShare = values.promote ? 0 : values.secondaryShare;
  return {
    lag,
    rpoOverrun,
    primaryHealth: linkHealth,
    secondaryHealth: worstHealth(lagHealth, linkHealth),
    localReadShare,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMb(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} GB` : `${value.toFixed(0)} MB`;
}

function seedSeries(frame: SimFrame, values: Computed, state: PromotionState, seed: number): void {
  const length = 20;
  const global = globalValues(values, state);
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.9);
  const rows: [string, number, number][] = [
    ["replication-lag", values.promote ? 0 : global.lag, 0.02],
    ["promotion-lag", values.promote ? global.lag : 0, 0.02],
    ["rpo-overrun", global.rpoOverrun, 0],
    ["link-utilization", values.linkUtil, 0.5],
    ["replay-shortfall", values.replayShortfall, 0],
    ["local-read-share", global.localReadShare, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.6) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, state: PromotionState): SimFrame {
  const values = compute(p);
  const global = globalValues(values, state);
  const promoted = values.promote;
  const newWriterHealth: Health = promoted ? healthFor(global.rpoOverrun, 0.1, 2) : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "primary",
        label: promoted ? "Old primary · us-east-1" : "Primary · us-east-1",
        kind: "db",
        role: promoted ? "replica" : "primary",
        health: promoted ? "down" : global.primaryHealth,
        sublabel: promoted
          ? "unavailable · reattach after recovery"
          : `${values.ingest.toFixed(1)} MB/s redo · ${formatCount(values.writeRate)} writes/s`,
        detail: promoted
          ? "The old primary is no longer the writer. Aurora attempts a failover snapshot of its storage when the Region recovers; the snapshot is a place to find writes the promoted cluster never received."
          : "The primary Region accepts every write. Storage replication to the secondary Regions is asynchronous, so a write is committed here before it is visible there.",
        meta: { view: "flow" },
      },
      {
        id: "secondary",
        label: promoted ? "Primary · eu-west-1 (promoted)" : "Secondary · eu-west-1",
        kind: "db",
        role: promoted ? "primary" : "replica",
        health: promoted ? newWriterHealth : global.secondaryHealth,
        sublabel: promoted
          ? `writer · lag at promotion ${global.lag.toFixed(1)}s`
          : `${global.lag.toFixed(1)}s behind · ${Math.round(values.secondaryShare)}% local reads`,
        detail: promoted
          ? `The secondary cluster is now the writer. The ${global.lag.toFixed(
              1,
            )}s of replication lag at promotion is the data-loss window; reads and writes now land in this Region.`
          : "The secondary cluster is read-only and serves local reads from its own copy of the cluster volume. It is consistent at a point in time, not at the primary's current point.",
        meta: { view: "flow", lag: promoted ? 0 : global.lag, localReads: global.localReadShare },
      },
    ],
    edges: [
      promoted
        ? edge("replication-stopped", "secondary", "primary", 0, "down", "replication stopped")
        : edge(
            "storage-replication",
            "primary",
            "secondary",
            clamp(values.link / Math.max(1, values.ingest)),
            global.secondaryHealth,
            "storage replication",
          ),
    ],
    metrics: [
      metric("replication-lag", "Replication lag", promoted ? 0 : global.lag, "s", 1, 5, "number"),
      metric("promotion-lag", "Lag at promotion", promoted ? global.lag : 0, "s", 1, 5, "number"),
      metric("rpo-overrun", "RPO overrun", global.rpoOverrun, "s", undefined, undefined, "number"),
      metric("link-utilization", "Replication link utilization", values.linkUtil, "%", 90, 120, "percent"),
      metric("replay-shortfall", "Replication shortfall", values.replayShortfall, " MB/s", undefined, undefined, "number"),
      metric("local-read-share", "Secondary Region read share", global.localReadShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      totalBacklogMb: state.totalBacklogMb,
      promotedLag: state.promotedLag ?? "",
      promote: promoted ? 1 : 0,
    },
    summary: promoted
      ? `Promoted to eu-west-1 with ${global.lag.toFixed(1)}s of lag; RPO overrun ${global.rpoOverrun.toFixed(
          1,
        )}s. The old primary is unavailable and the other secondaries rebuild from the new writer.`
      : `${values.ingest.toFixed(1)} MB/s redo at ${Math.round(values.linkUtil)}% of the link; secondary ${global.lag.toFixed(
          1,
        )}s behind, ${formatMb(state.totalBacklogMb)} backlog; ${Math.round(global.localReadShare)}% local reads.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 1,
    crit: 5,
    title: "Secondary Region freshness is outside the recovery target",
    cause:
      "Aurora Global Database replicates storage asynchronously. A write burst or a constrained cross-Region path makes the secondary volume fall behind the primary. During an unplanned promotion, that lag becomes the data-loss window.",
    fix:
      "Compare the lag with the RPO before promotion. Choose the secondary with the least lag, reduce the write burst, or use a planned switchover when all clusters are healthy and the operation can wait for synchronization.",
    checkFirst: [
      "Read AuroraGlobalDBRPOLag for every secondary cluster from the primary cluster.",
      "Check AuroraGlobalDBDataTransferBytes and the write rate on the primary.",
      "Check whether a write burst, bulk load, or index build changed the redo rate.",
    ],
  },
  {
    id: "promotion-lag",
    metricId: "promotion-lag",
    warn: 1,
    crit: 5,
    title: "Lag at promotion exceeds the RPO",
    cause:
      "The secondary cluster was promoted at a point behind the old primary. Because storage replication is asynchronous, the promoted volume does not contain writes after that point; the lag at promotion is the data-loss window.",
    fix:
      "Use a planned switchover when the primary is healthy, because it waits for synchronization and has RPO 0. After an unplanned promotion, reconcile from the old primary's failover snapshot, application records, and idempotency keys.",
    checkFirst: [
      "Record the lag of the promoted secondary at the moment of promotion.",
      "Check whether the old primary's failover snapshot is available.",
      "Check which writes were acknowledged in the lag window.",
    ],
  },
  {
    id: "link-utilization",
    metricId: "link-utilization",
    warn: 90,
    crit: 120,
    title: "Redo generation exceeds cross-Region replication capacity",
    cause:
      "The primary is producing more redo than the replication path can transfer. The link stays busy and the secondary backlog grows; reads in the secondary Region remain local but become older.",
    fix:
      "Reduce redo generation or spread the write burst, and verify the replication path's health. If the workload is expected to grow, plan the secondary Regions and failover strategy around the sustained redo rate, not the average.",
    checkFirst: [
      "Compare write rate and redo per write with the link's delivered throughput.",
      "Check AuroraGlobalDBReplicationLag and AuroraGlobalDBProgressLag for the same secondary.",
      "Check whether the burst is transient or a new steady state.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const globalModel: SimModel = {
  id: "databases-aurora-global",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const state: PromotionState = { totalBacklogMb: 0, promotedLag: null };
    const frame = buildFrame(defaults(), seed, state);
    seedSeries(frame, compute(defaults()), state, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const values = compute(p);
    const seconds = clamp(dt, 0.01, 1);
    const previousTotal =
      typeof frame.flags.totalBacklogMb === "number" && Number.isFinite(frame.flags.totalBacklogMb)
        ? Math.max(0, frame.flags.totalBacklogMb)
        : 0;
    const previousPromote = frame.flags.promote === 1;
    const previousPromotedLag =
      typeof frame.flags.promotedLag === "number" && Number.isFinite(frame.flags.promotedLag)
        ? frame.flags.promotedLag
        : null;
    const burstLag =
      values.ingest > values.link ? PROMOTION_BURST_S * (1 - values.link / values.ingest) : 0;
    let totalBacklogMb = previousTotal;
    let promotedLag: number | null = previousPromotedLag;
    if (values.promote) {
      if (!previousPromote || promotedLag === null) {
        const currentLag = previousTotal / Math.max(values.ingest, 0.1) + 0.05;
        promotedLag = Math.max(currentLag, burstLag + 0.05);
      }
    } else {
      totalBacklogMb = clamp(
        previousTotal + (values.ingest - values.link) * seconds,
        0,
        MAX_BACKLOG_MB,
      );
      promotedLag = null;
    }
    const state: PromotionState = { totalBacklogMb, promotedLag };
    const global = globalValues(values, state);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), state);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (!values.promote && global.secondaryHealth === "crit" && frame.flags.behindLogged !== 1) {
      pushEvent(next, {
        id: "global-replication-behind",
        at: frame.t + seconds,
        severity: "crit",
        title: "Secondary Region is behind the recovery target",
        detail: `The secondary is ${global.lag.toFixed(
          1,
        )}s behind and the RPO target is ${RPO_TARGET_S}s. Promotion now would discard roughly ${global.rpoOverrun.toFixed(
          1,
        )}s beyond the target.`,
        nodeId: "secondary",
        metricId: "replication-lag",
      });
    }
    next.flags.behindLogged = !values.promote && global.secondaryHealth === "crit" ? 1 : 0;

    if (values.promote && frame.flags.promotedLogged !== 1) {
      pushEvent(next, {
        id: "secondary-promoted",
        at: frame.t + seconds,
        severity: global.rpoOverrun > 0 ? "crit" : "warn",
        title: "Secondary cluster promoted to writer",
        detail: `Writes now land in eu-west-1. The lag at promotion was ${global.lag.toFixed(
          1,
        )}s, so ${global.rpoOverrun.toFixed(
          1,
        )}s of data is outside the ${RPO_TARGET_S}s RPO. The other secondary clusters must rebuild from the new primary.`,
        nodeId: "secondary",
        metricId: "rpo-overrun",
      });
    }
    next.flags.promotedLogged = values.promote ? 1 : 0;

    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const items: string[] = values.promote
      ? [
          `Promotion stopped replication to the old primary. The lag at promotion was ${(
            frame.metrics.find((item) => item.id === "promotion-lag")?.value ?? 0
          ).toFixed(1)}s; that is the data-loss window, not a live link problem.`,
        ]
      : [
          `Aurora replicates the cluster volume, not the SQL statements. ${values.ingest.toFixed(
            1,
          )} MB/s of redo against a ${values.link.toFixed(0)} MB/s path puts the link at ${Math.round(
            values.linkUtil,
          )}% and the shortfall at ${values.replayShortfall.toFixed(1)} MB/s.`,
        ];
    items.push(
      values.promote
        ? "The promoted cluster now accepts writes and serves reads in its Region. The old primary is unavailable until it rejoins as a secondary, and the other secondary clusters rebuild from the new writer."
        : "The secondary cluster is read-only and serves local reads from its own copy of the volume. It does not run a second writer, and it does not have the primary's current point until replication catches up.",
    );
    if (!values.promote) {
      items.push(
        "A planned switchover requires healthy clusters, waits for the target secondary to synchronize, and has RPO 0. An unplanned failover promotes at the secondary's current point, so its RPO is the lag at failure.",
      );
    }
    items.push(
      "Instance configuration, parameter groups, monitoring, and integrations are regional. The promoted cluster does not inherit them from the old primary, so verify them before resuming writes.",
    );
    items.push(
      "Aurora Global Database supports up to 10 secondary DB clusters in different Regions; a secondary cluster can have up to 16 read-only instances. These are service limits, not tuning targets.",
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
    description: "Redo generation is well inside the cross-Region path; the secondary is current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Write burst",
    description: "A burst pushes the link into its warning band and the secondary falls a few seconds behind.",
    tone: "warn",
    params: defaults({ writeRate: 12_000, writeSizeKb: 4, linkBandwidth: 40, secondaryReadShare: 85 }),
  },
  {
    id: "failure",
    label: "Saturated replication",
    description: "Redo is far above the link capacity; the secondary falls outside the RPO target.",
    tone: "crit",
    params: defaults({ writeRate: 24_000, writeSizeKb: 4, linkBandwidth: 20, secondaryReadShare: 80 }),
  },
  {
    id: "promoted",
    label: "Promotion under lag",
    description: "The secondary is promoted while its volume is seconds behind; the lag becomes the data-loss window.",
    tone: "crit",
    params: defaults({ writeRate: 12_000, writeSizeKb: 4, linkBandwidth: 20, secondaryReadShare: 80, promote: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The write burst ends, the link catches up, and the secondary returns inside the RPO.",
    tone: "ok",
    params: defaults({ writeRate: 5_000, writeSizeKb: 4, linkBandwidth: 60, secondaryReadShare: 70 }),
  },
];

const experiment: Experiment = {
  id: "what-replicates",
  title: "What has actually reached the secondary Region?",
  simId: "aurora-global",
  question:
    "A write commits in the primary Region. Before the change is visible in a secondary Region, what has happened?",
  prediction: {
    options: [
      { id: "cache", label: "The secondary replayed the write but its cache is cold." },
      { id: "storage", label: "The primary storage has the commit; asynchronous storage replication has not reached the secondary volume." },
      { id: "readonly", label: "The secondary rejected the write because it is read-only, so the primary retried it." },
      { id: "copy", label: "Aurora copied the table to the secondary during cluster creation, and the copy is now stale." },
    ],
    correctOptionId: "storage",
    explanation:
      "Writes go to the primary cluster's storage volume. Aurora Global Database replicates storage changes to the secondary cluster volumes asynchronously. The secondary cluster is read-only and serves reads from its own copy at an earlier point in time. It did not reject the write, and adding a secondary did not copy each table; the secondary attaches to a replicated volume.",
  },
  setup: defaults({ writeRate: 12_000, writeSizeKb: 4, linkBandwidth: 40, secondaryReadShare: 85 }),
  runFor: 20,
  observe: [
    "The replication link is above 100% of its illustrative capacity.",
    "The secondary falls behind by a few seconds while local reads continue.",
    "RPO overrun grows when lag passes the one-second target.",
    "The secondary is still read-only; the writer has not moved.",
  ],
  explain:
    "The secondary volume is a consistent copy at an earlier point. Local reads are fast because they stay in the Region, but they see only the replicated point. Promotion changes the writer role; it does not replay the missing redo from the old primary. That is why the lag at promotion is the data-loss window and a planned switchover, which waits for synchronization, has RPO 0.",
  fix: defaults({ writeRate: 8_000, writeSizeKb: 4, linkBandwidth: 80, secondaryReadShare: 70 }),
  debrief:
    "Reducing the write burst and giving the replication path headroom brings the lag under a second. The secondary remains a read-only copy until promotion. If promotion is planned, wait for synchronization; if it is an outage, choose the secondary with the least lag and reconcile the missing window.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Aurora Global Database is one Aurora database spread across AWS Regions. It has one primary DB cluster in a primary Region and up to 10 read-only secondary DB clusters in different Regions. Writes go to the primary cluster. Aurora replicates the cluster storage to each secondary Region using dedicated infrastructure, with latency typically under a second. The secondary clusters serve local reads, which keeps read latency low for users near those Regions.",
  },
  {
    type: "p",
    text: "The replication is at the storage layer. Aurora does not ship SQL statements or run a second writer in each Region. Each secondary cluster has its own copy of the cluster volume and attaches its own read-only instances to it. That is why a secondary can serve reads without a local writer, and why it can only be as fresh as the replicated storage point.",
  },
  {
    type: "p",
    text: "Promotion changes the writer. A switchover is planned: all clusters are healthy, Aurora waits for the target secondary to synchronize, and the operation has RPO 0. A failover is for an unplanned outage: the chosen secondary is promoted at its current point, so the replication lag at failure becomes the data-loss window. After a failover, the other secondary clusters are rebuilt from the new primary; a switchover preserves the existing replication topology.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Applications write through the Aurora Global Database writer endpoint, which always points to the primary cluster, even after a switchover or failover. Reads in a secondary Region can use that cluster's reader endpoint and local read-only instances. The path is application, endpoint, DB instance, then the cluster volume. Between Regions, the path is primary storage, replication infrastructure, and secondary storage.",
  },
  {
    type: "compare",
    leftTitle: "Planned switchover",
    rightTitle: "Unplanned failover",
    rows: [
      { label: "Precondition", left: "All clusters healthy", right: "Primary Region unavailable or failing" },
      { label: "Waits for sync", left: "Yes", right: "No" },
      { label: "RPO", left: "0", right: "Replication lag at failure" },
      { label: "Writer endpoint", left: "Follows the new primary", right: "Follows the promoted cluster" },
      { label: "Other secondaries", left: "Topology preserved", right: "Rebuilt from the new primary" },
    ],
  },
  {
    type: "p",
    text: "What replicates is the cluster volume. What stays regional includes DB instance classes, parameter groups, monitoring configuration, and integrations with other services. A promoted secondary does not inherit the old primary's settings, so check them before resuming full write traffic. The old primary can rejoin as a secondary when its Region is healthy; it is not automatically the writer again.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replication lag: how far the secondary volume is behind the primary. Warning at 1 second, critical at 5 seconds.",
      "Lag at promotion: the lag captured when the secondary becomes the writer, shown as the data-loss window.",
      "RPO overrun: lag beyond the one-second recovery target used in this model.",
      "Replication link utilization: redo generation compared with the cross-Region path, warning at 90% and critical at 120%.",
      "Replication shortfall: the rate at which the backlog grows when redo exceeds the link.",
      "Secondary Region read share: reads served in the secondary Region, and how their freshness follows the lag.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Write burst and watch the link utilization and lag move together. Apply Saturated replication to cross the RPO. Then set Promote secondary to 1 and compare the lag at promotion with the old primary's state. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Bandwidth, redo size, lag thresholds, and the ten-second promotion assumption are illustrative teaching values, not Aurora guarantees. Aurora documents replication latency typically under a second and an unplanned RPO measured in seconds. The model uses one-second and five-second thresholds to make the tradeoff visible.",
  },
  { type: "sim", simId: "aurora-global" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary committed writes and generated redo faster than the cross-Region path could deliver it. The secondary volume fell behind, so local reads stayed fast but returned an older point in time. The link stayed busy, the backlog grew, and the RPO overrun increased once the lag passed the target.",
  },
  {
    type: "p",
    text: "Promotion moved the writer to the secondary Region. The lag at that moment became the data-loss window; writes after the secondary's point were never in its volume. A planned switchover would have waited for synchronization and had RPO 0, but it requires a healthy primary and all clusters to be reachable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "AuroraGlobalDBRPOLag and AuroraGlobalDBReplicationLag in milliseconds for each secondary cluster; read them from the primary cluster.",
      "AuroraGlobalDBDataTransferBytes for cross-Region redo volume, and AuroraGlobalDBProgressLag for storage progress.",
      "RDS events for switchover or failover start and completion, write fencing, and the old primary reattaching.",
      "The global writer endpoint's DNS resolution and the application's connection pools after promotion.",
      "Per-Region configuration: parameter groups, monitoring, secrets, and integrations that the promoted cluster did not inherit.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the lag for every secondary before choosing one. Compare it with the RPO, and check whether a planned switchover is possible. If the primary is gone, choose the least-lagged secondary and start reconciliation from the old primary's failover snapshot when it becomes available.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the lag per secondary and compare it with the RPO. Do not use a cluster-wide average.",
      "If the primary is healthy, use a switchover; it waits for synchronization and has RPO 0.",
      "If the primary is unavailable, pick the least-lagged secondary and promote it. Accept that the lag is the data-loss window.",
      "Reduce the sustained redo rate or give the replication path headroom if the burst is a new steady state.",
      "Point applications at the global writer endpoint, or update connection strings if they used the old cluster endpoint.",
      "Rebuild the other secondary clusters from the new primary, then reattach the old Region as a secondary.",
      "Reconcile the missing window from the old primary's failover snapshot, application records, and idempotency keys.",
      "For Aurora PostgreSQL, use the rds.global_db_rpo parameter only after measuring its commit-pause cost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Local reads save cross-Region latency but return a copy that is behind. The product must decide which reads accept that.",
      "A lower RPO means less data at risk and, with rds.global_db_rpo, potentially blocked commits when every secondary is behind.",
      "More secondary Regions improve read locality and recovery options but multiply replication traffic and operational surface.",
      "A planned switchover is zero-loss but requires healthy clusters and a coordinated cutover; it is not an outage recovery method.",
      "A failover is faster in a disaster but loses the unreplicated window and can create split-brain if the old primary still accepts writes.",
      "Rebuilding other secondaries after promotion takes time and reduces read capacity in those Regions until it finishes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-global",
    question: "What does Aurora Global Database replicate, and what does it not replicate?",
    difficulty: 2,
    hints: [
      "It is storage replication, not statement replication.",
      "Regional configuration is separate.",
    ],
    answer:
      "It replicates the Aurora cluster volume from the primary Region to each secondary Region asynchronously. The secondary clusters attach their own read-only instances to that replicated volume, so they can serve local reads without a local writer. It does not replicate DB instance configuration, parameter groups, monitoring setup, or integrations. It also does not create a second active writer; writes go to the primary cluster until promotion. After promotion, the new primary does not inherit the old primary's regional configuration, so those settings must be checked.",
    followUps: [
      "Why can a secondary serve reads without a writer?",
      "What has to be reconfigured after promotion?",
      "What happens to the old primary when its Region recovers?",
    ],
    redFlags: [
      "Says it replicates SQL statements.",
      "Says every Region has an active writer.",
      "Assumes configuration follows the data.",
    ],
    rubric: [
      "Names storage replication.",
      "Names read-only secondary clusters.",
      "Separates regional configuration.",
      "States single writer until promotion.",
    ],
  },
  {
    id: "plan-failover",
    question: "How would you plan failover for a two-Region Aurora Global Database with a one-second RPO?",
    difficulty: 3,
    hints: [
      "Separate planned switchover from unplanned failover.",
      "Measure lag per secondary and rehearsal time.",
    ],
    answer:
      "I would document two paths. For planned work, use switchover: verify both clusters are healthy, confirm engine version compatibility, wait for synchronization, and accept a short write pause with RPO 0. For an outage, use failover: monitor AuroraGlobalDBRPOLag for the secondary, choose the least-lagged target if there is more than one, promote, and expect a non-zero loss bounded by the lag at failure. I would use the global writer endpoint so the application does not need a new hostname, keep DNS TTLs low, and rehearse the cutover including connection-pool reconnect. I would also prepare reconciliation from the old primary's failover snapshot and verify the new primary's parameter groups and integrations.",
    followUps: [
      "What would make you choose a different secondary?",
      "How would you test the application cutover?",
      "What would you do if the old primary is still accepting writes?",
    ],
    redFlags: [
      "Promises RPO 0 for an unplanned failover.",
      "Ignores connection strings and DNS.",
      "Skips configuration parity.",
    ],
    rubric: [
      "Separates switchover and failover.",
      "Uses per-secondary lag.",
      "Uses the global writer endpoint.",
      "Plans reconciliation and configuration checks.",
    ],
  },
  {
    id: "lag-or-rpo",
    question: "Why is replication lag not the same as the RPO you would report after a failover?",
    difficulty: 3,
    hints: [
      "Lag is a measurement; RPO is a policy outcome.",
      "The promotion point matters.",
    ],
    answer:
      "Replication lag is the current distance between the primary and a secondary. RPO is the amount of data the business accepts losing. At an unplanned failover, the loss is bounded by the lag at the moment of promotion, but it is not identical to a dashboard average: the lag varies by secondary, and the chosen secondary may not be the freshest. A planned switchover waits for synchronization and has RPO 0. So I would report the lag at promotion for the chosen secondary, compare it with the target, and describe the reconciliation plan rather than quoting the steady-state average.",
    followUps: [
      "How would you choose the least-lagged secondary?",
      "What if the lag metric is sampled every minute?",
      "How does rds.global_db_rpo change the answer?",
    ],
    redFlags: [
      "Equates average lag with RPO.",
      "Ignores the chosen secondary.",
      "Assumes a failover waits for sync.",
    ],
    rubric: [
      "Defines lag and RPO separately.",
      "Uses the lag at promotion.",
      "Chooses the least-lagged secondary.",
      "Mentions the planned path.",
    ],
  },
  {
    id: "local-reads",
    question: "A product wants all reads in the secondary Region to be local. What do you tell them about freshness?",
    difficulty: 2,
    hints: [
      "Local reads are fast but not current.",
      "The product decides which reads tolerate it.",
    ],
    answer:
      "I would say local reads are served from the secondary cluster's replicated volume, so they are fast but only as fresh as the replication lag. A read that must see a write from the primary Region, or a read-after-write in the same session, may need the global writer endpoint or a version boundary. I would classify read paths by freshness requirement and keep the strict ones on the writer. I would also show them the lag distribution and the RPO target so the tradeoff is explicit, not hidden in an average.",
    followUps: [
      "Which read paths would you keep on the writer?",
      "How would you measure the user impact of staleness?",
      "What if the lag is normally under a second?",
    ],
    redFlags: [
      "Promises strong consistency for all local reads.",
      "Ignores read-after-write.",
      "Uses an average lag as a guarantee.",
    ],
    rubric: [
      "States local reads are behind.",
      "Classifies read paths.",
      "Names the writer or version boundary.",
      "Uses lag distribution and RPO.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The RPO and RTO are written down for the global database and each data class.",
      "The global writer endpoint is used for writes, and DNS TTLs are low enough for cutover.",
      "Lag alarms use AuroraGlobalDBRPOLag per secondary, not a cluster average.",
      "A switchover runbook and a separate failover runbook exist and are rehearsed.",
      "Parameter groups, monitoring, secrets, and integrations are compared across Regions.",
      "A reconciliation plan exists for the lag window.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read lag for every secondary before choosing a promotion target.",
      "Decide whether the situation allows a planned switchover or requires an unplanned failover.",
      "Stop writes to the old primary where possible and watch for split-brain.",
      "Promote, verify the new writer through the global endpoint, and confirm writes succeed.",
      "Record the lag at promotion and start reconciliation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Rebuild the other secondary clusters from the new primary.",
      "Reattach the old Region as a secondary when it recovers.",
      "Reconcile the missing window and verify affected business records.",
      "Fail back with a planned switchover after the topology is healthy.",
      "Update the runbooks and alarms with the observed lag and cutover time.",
    ],
  },
];

const references = [
  {
    title: "Using Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Primary and secondary clusters, storage-level asynchronous replication, and typical sub-second latency.",
  },
  {
    title: "Switchover or failover in Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Planned switchover with RPO 0, unplanned failover with non-zero RPO, and the failover snapshot.",
  },
  {
    title: "Amazon Aurora endpoint connections",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.Endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The global writer endpoint and how it follows the primary across Regions.",
  },
  {
    title: "Amazon CloudWatch metrics for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AuroraGlobalDBRPOLag, AuroraGlobalDBReplicationLag, AuroraGlobalDBProgressLag, and data transfer metrics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "aurora-global": {
      model: globalModel,
      presets,
      instructions:
        "Start healthy. Apply Write burst and compare link utilization with lag. Apply Saturated replication to cross the RPO, then set Promote secondary to 1 and compare the lag at promotion with the old primary's state.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Bandwidth, redo, thresholds, and the 10-second promotion assumption are teaching values, not Aurora guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-cross-region-rpo",
    "databases-write-forwarding",
    "databases-failover-dns",
  ],
};
