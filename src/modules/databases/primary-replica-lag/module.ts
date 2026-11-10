import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_BACKLOG_MB = 8_192;
const READ_SPREAD_S = 10;

const params = [
  {
    id: "writeRate",
    label: "Primary write rate",
    min: 200,
    max: 20_000,
    step: 200,
    value: 1_500,
    unit: " writes/s",
    group: "Primary",
    help: "Committed transactions per second. Each one produces write-ahead log (WAL) that must reach and replay on the replica.",
    format: "rps" as const,
  },
  {
    id: "walPerWrite",
    label: "WAL per write",
    min: 1,
    max: 32,
    step: 1,
    value: 4,
    unit: " KB",
    group: "Primary",
    help: "Average WAL generated per transaction. Wide rows, full-page writes, and index changes increase it.",
    format: "number" as const,
  },
  {
    id: "receiveRate",
    label: "WAL receive rate",
    min: 2,
    max: 200,
    step: 2,
    value: 40,
    unit: " MB/s",
    group: "Replica",
    help: "Rate at which the replica can receive and write WAL. Network distance and receiver I/O bound it.",
    format: "number" as const,
  },
  {
    id: "applyRate",
    label: "WAL replay rate",
    min: 2,
    max: 200,
    step: 2,
    value: 20,
    unit: " MB/s",
    group: "Replica",
    help: "Rate at which the replica can replay received WAL into its data files and make it visible to reads.",
    format: "number" as const,
  },
  {
    id: "readRate",
    label: "Read traffic",
    min: 100,
    max: 20_000,
    step: 100,
    value: 3_000,
    unit: " reads/s",
    group: "Readers",
    help: "Reads served by the replica. A larger read rate makes each second of lag affect more users.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  writeRate: number;
  walPerWrite: number;
  receiveRate: number;
  applyRate: number;
  readRate: number;
  ingest: number;
  pipelineThroughput: number;
  applyUtil: number;
  receiveUtil: number;
  replayShortfall: number;
  transferShortfall: number;
}

function compute(p: Params): Computed {
  const writeRate = Math.max(0, num(p, "writeRate", 1_500));
  const walPerWrite = Math.max(0, num(p, "walPerWrite", 4));
  const receiveRate = Math.max(0.1, num(p, "receiveRate", 40));
  const applyRate = Math.max(0.1, num(p, "applyRate", 20));
  const readRate = Math.max(0, num(p, "readRate", 3_000));
  const ingest = (writeRate * walPerWrite) / 1_024;
  const pipelineThroughput = Math.min(receiveRate, applyRate);
  const received = Math.min(ingest, receiveRate);
  return {
    writeRate,
    walPerWrite,
    receiveRate,
    applyRate,
    readRate,
    ingest,
    pipelineThroughput,
    applyUtil: Math.min(100, (received / applyRate) * 100),
    receiveUtil: Math.min(100, (ingest / receiveRate) * 100),
    replayShortfall: Math.max(0, received - applyRate),
    transferShortfall: Math.max(0, ingest - receiveRate),
  };
}

interface LagState {
  totalBacklogMb: number;
  receiveBacklogMb: number;
}

interface LagValues {
  lag: number;
  applyBacklog: number;
  receiveGap: number;
  staleShare: number;
  staleReads: number;
  replicaHealth: Health;
}

function lagValues(values: Computed, state: LagState): LagValues {
  const total = clamp(state.totalBacklogMb, 0, MAX_BACKLOG_MB);
  const receiveGap = clamp(state.receiveBacklogMb, 0, total);
  const applyBacklog = Math.max(0, total - receiveGap);
  const lag = values.ingest > 0 && total > 0 ? total / values.ingest + 0.05 : 0;
  const staleShare = min(clamp((lag / READ_SPREAD_S) * 100, 0, 100), 100);
  const staleReads = values.readRate * (staleShare / 100);
  const replicaHealth: Health =
    lag >= 5 || applyBacklog >= 256 || receiveGap >= 256 || values.applyUtil >= 99.5
      ? "crit"
      : lag >= 2 || applyBacklog >= 64 || receiveGap >= 64 || values.applyUtil >= 95
        ? "warn"
        : "ok";
  return { lag, applyBacklog, receiveGap, staleShare, staleReads, replicaHealth };
}

function min(a: number, b: number): number {
  return a < b ? a : b;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatMb(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} GB` : `${value.toFixed(0)} MB`;
}

function seedSeries(frame: SimFrame, values: Computed, lagged: LagValues, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.8);
  const rows: [string, number, number][] = [
    ["replication-time-lag", lagged.lag, 0.03],
    ["apply-backlog", lagged.applyBacklog, 0],
    ["receive-gap", lagged.receiveGap, 0],
    ["stale-read-rate", lagged.staleReads, 4],
    ["replay-shortfall", values.replayShortfall, 0],
    ["apply-utilization", values.applyUtil, 0.4],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.5) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, state: LagState): SimFrame {
  const values = compute(p);
  const lagged = lagValues(values, state);
  return {
    t: 0,
    nodes: [
      {
        id: "primary",
        label: "Primary · WAL sender",
        kind: "db",
        role: "primary",
        health: "ok",
        sublabel: `${values.ingest.toFixed(1)} MB/s WAL · ${formatCount(values.writeRate)} writes/s`,
        detail: `The primary commits locally and streams WAL. Its write latency is not waiting for the replica; the replica's freshness is the tradeoff.`,
        meta: { view: "flow" },
      },
      {
        id: "replica",
        label: "Read replica",
        kind: "db",
        role: "replica",
        health: lagged.replicaHealth,
        utilization: clamp(values.applyUtil / 100),
        sublabel: `${lagged.lag.toFixed(1)}s lag · ${formatMb(lagged.applyBacklog)} to replay`,
        detail: `The replica receives WAL at ${values.receiveUtil.toFixed(
          0,
        )}% of its receive capacity and replays at ${values.applyUtil.toFixed(
          0,
        )}% of its replay capacity. Reads see only replayed data.`,
        meta: {
          view: "flow",
          lag: lagged.lag,
          applyBacklogMb: lagged.applyBacklog,
          receiveGapMb: lagged.receiveGap,
        },
      },
    ],
    edges: [
      edge(
        "wal-stream",
        "primary",
        "replica",
        clamp(values.pipelineThroughput / Math.max(1, values.ingest)),
        lagged.replicaHealth,
        "WAL stream",
      ),
    ],
    metrics: [
      metric("replication-time-lag", "Recent-WAL time lag", lagged.lag, "s", 2, 5, "number"),
      metric("apply-backlog", "Received but not replayed", lagged.applyBacklog, " MB", 64, 256, "number"),
      metric("receive-gap", "WAL not yet received", lagged.receiveGap, " MB", 64, 256, "number"),
      metric("stale-read-rate", "Stale reads", lagged.staleReads, " reads/s", 100, 500, "rps"),
      metric("replay-shortfall", "Replay shortfall", values.replayShortfall, " MB/s", undefined, undefined, "number"),
      metric("apply-utilization", "Replay utilization", values.applyUtil, "%", 95, 99.5, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      totalBacklogMb: state.totalBacklogMb,
      receiveBacklogMb: state.receiveBacklogMb,
    },
    summary: `${lagged.lag.toFixed(1)}s recent-WAL lag; ${formatMb(lagged.applyBacklog)} received but not replayed; ${formatMb(
      lagged.receiveGap,
    )} not yet received; ${formatCount(lagged.staleReads)} stale reads/s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replication-time-lag",
    metricId: "replication-time-lag",
    warn: 2,
    crit: 5,
    title: "Replica freshness has exceeded the read target",
    cause:
      "The replica is behind the primary by more than the read freshness target. Time lag measures recent WAL, so it can look small while a backlog exists; here the backlog has grown enough to move it.",
    fix:
      "Find whether transfer or replay is the bottleneck. Raise the limiting capacity, reduce WAL generation, or route reads that need freshness to the primary. Do not trust a single lag number without the byte gap.",
    checkFirst: [
      "Compare WAL receive rate with replay rate.",
      "Compare the primary's current WAL position with the replica's replay position.",
      "Check whether one large transaction or index build produced a WAL burst.",
    ],
  },
  {
    id: "apply-backlog",
    metricId: "apply-backlog",
    warn: 64,
    crit: 256,
    title: "WAL has arrived but is not replayed",
    cause:
      "The replica's replay capacity is below the primary's WAL generation rate. The bytes are on the replica, but reads cannot see them until the startup process applies them.",
    fix:
      "Reduce replay work or add replay capacity. On PostgreSQL, check whether a long transaction, a large index build, or single-threaded replay is limiting progress. A faster network will not fix an apply bottleneck.",
    checkFirst: [
      "Check replay_lag and the replay LSN on the replica.",
      "Check replica CPU and I/O while replay is behind.",
      "Check whether a long transaction is holding back visibility.",
    ],
  },
  {
    id: "stale-read-rate",
    metricId: "stale-read-rate",
    warn: 100,
    crit: 500,
    title: "Too many reads can see stale data",
    cause:
      "Reads are being served from a replica that has not replayed the latest writes. The affected rate is the read rate multiplied by the share of reads that arrive inside the lag window.",
    fix:
      "Route read-after-write traffic to the primary, shorten the lag, or add a consistency mechanism such as a version boundary. More replicas do not reduce a shared replay backlog.",
    checkFirst: [
      "Check which read paths require read-your-writes.",
      "Compare the lag with the product's freshness promise.",
      "Check whether the reader pool is pinned to the lagging replica.",
    ],
  },
  {
    id: "apply-utilization",
    metricId: "apply-utilization",
    warn: 95,
    crit: 99.5,
    title: "Replay capacity is nearly exhausted",
    cause:
      "WAL is arriving at close to the rate the replica can replay. The replica is current now, but a small write burst or a slower apply path will start a backlog with almost no headroom.",
    fix:
      "Add replay headroom, reduce WAL generation, or accept that the next burst will build a backlog. Watch the byte gap before the time lag moves.",
    checkFirst: [
      "Compare WAL generation with replay capacity.",
      "Check replica CPU and I/O at the current replay rate.",
      "Check for a recent increase in WAL per write or transaction rate.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function initialState(): LagState {
  return { totalBacklogMb: 0, receiveBacklogMb: 0 };
}

export const replicaLagModel: SimModel = {
  id: "databases-primary-replica-lag",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const state = initialState();
    const frame = buildFrame(defaults(), seed, state);
    seedSeries(frame, compute(defaults()), lagValues(compute(defaults()), state), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const values = compute(p);
    const seconds = clamp(dt, 0.01, 1);
    const previousTotal =
      typeof frame.flags.totalBacklogMb === "number" && Number.isFinite(frame.flags.totalBacklogMb)
        ? Math.max(0, frame.flags.totalBacklogMb)
        : 0;
    const previousReceive =
      typeof frame.flags.receiveBacklogMb === "number" && Number.isFinite(frame.flags.receiveBacklogMb)
        ? Math.max(0, frame.flags.receiveBacklogMb)
        : 0;
    const totalBacklogMb = clamp(
      previousTotal + (values.ingest - values.pipelineThroughput) * seconds,
      0,
      MAX_BACKLOG_MB,
    );
    const receiveBacklogMb = clamp(
      Math.min(totalBacklogMb, previousReceive + (values.ingest - values.receiveRate) * seconds),
      0,
      totalBacklogMb,
    );
    const state: LagState = { totalBacklogMb, receiveBacklogMb };
    const lagged = lagValues(values, state);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), state);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (lagged.receiveGap > 0.5 && frame.flags.transferLogged !== 1) {
      pushEvent(next, {
        id: "wal-transfer-behind",
        at: frame.t + seconds,
        severity: lagged.receiveGap >= 256 ? "crit" : "warn",
        title: "WAL transfer is the bottleneck",
        detail: `The primary generates ${values.ingest.toFixed(
          1,
        )} MB/s of WAL and the replica can receive ${values.receiveRate.toFixed(
          0,
        )} MB/s. ${formatMb(lagged.receiveGap)} has not arrived yet.`,
        nodeId: "replica",
        metricId: "receive-gap",
      });
    }
    next.flags.transferLogged = lagged.receiveGap > 0.5 ? 1 : 0;

    if (lagged.applyBacklog > 0.5 && frame.flags.applyLogged !== 1) {
      pushEvent(next, {
        id: "wal-replay-behind",
        at: frame.t + seconds,
        severity: lagged.applyBacklog >= 256 ? "crit" : "warn",
        title: "Replay is the bottleneck",
        detail: `${formatMb(lagged.applyBacklog)} of WAL has arrived but is not replayed. The replica can replay ${values.applyRate.toFixed(
          0,
        )} MB/s against ${values.ingest.toFixed(1)} MB/s of incoming WAL.`,
        nodeId: "replica",
        metricId: "apply-backlog",
      });
    }
    next.flags.applyLogged = lagged.applyBacklog > 0.5 ? 1 : 0;

    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const state: LagState = {
      totalBacklogMb:
        typeof frame.flags.totalBacklogMb === "number" ? frame.flags.totalBacklogMb : 0,
      receiveBacklogMb:
        typeof frame.flags.receiveBacklogMb === "number" ? frame.flags.receiveBacklogMb : 0,
    };
    const lagged = lagValues(values, state);
    const items: string[] = [
      `The primary generates ${values.ingest.toFixed(1)} MB/s of WAL; the pipeline can move ${values.pipelineThroughput.toFixed(
        0,
      )} MB/s, so the backlog is changing at ${(values.ingest - values.pipelineThroughput).toFixed(1)} MB/s.`,
    ];
    if (lagged.receiveGap > lagged.applyBacklog) {
      items.push(
        `Most of the backlog is WAL that has not arrived: ${formatMb(
          lagged.receiveGap,
        )} in the transfer gap. Replay is not the first bottleneck; the receive rate is.`,
      );
    } else if (lagged.applyBacklog > 0) {
      items.push(
        `The transfer is keeping up, but ${formatMb(
          lagged.applyBacklog,
        )} has arrived and is waiting for replay. A network upgrade would not shorten this lag.`,
      );
    } else {
      items.push("The replica is caught up; transfer and replay both exceed the WAL generation rate.");
    }
    items.push(
      `Time lag is ${lagged.lag.toFixed(
        1,
      )}s. It is measured from recent WAL, not from the oldest unapplied change, so use the byte gap before trusting it.`,
    );
    items.push(
      `About ${formatCount(lagged.staleReads)} reads per second can arrive before the replica catches up, assuming post-write reads spread over ${READ_SPREAD_S} seconds.`,
    );
    items.push(
      "On PostgreSQL, compare pg_current_wal_lsn() with the standby's replay LSN, and read pg_stat_wal_receiver on the standby. On Aurora, AuroraReplicaLag is time-based; OldestReplicationSlotLag is byte-based.",
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
    description: "Replay capacity exceeds WAL generation; the replica stays current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak writes",
    description: "WAL generation sits just under replay capacity. The replica keeps up, but replay has almost no burst headroom.",
    tone: "warn",
    params: defaults({ writeRate: 3_300, walPerWrite: 8, applyRate: 26, readRate: 4_000 }),
  },
  {
    id: "failure",
    label: "Replay stall",
    description: "The replica receives WAL faster than it can replay it. Reads get staler while the network looks fine.",
    tone: "crit",
    params: defaults({ writeRate: 6_000, walPerWrite: 8, receiveRate: 60, applyRate: 12, readRate: 4_000 }),
  },
  {
    id: "network-stall",
    label: "Transfer stall",
    description: "Replay could keep up, but WAL arrives too slowly. The transfer gap grows and replay has nothing to apply.",
    tone: "crit",
    params: defaults({ writeRate: 6_000, walPerWrite: 8, receiveRate: 20, applyRate: 40, readRate: 4_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "WAL generation is modest and replay capacity has headroom; the replica stays current.",
    tone: "ok",
    params: defaults({ writeRate: 1_500, walPerWrite: 4, receiveRate: 40, applyRate: 30, readRate: 3_000 }),
  },
];

const experiment: Experiment = {
  id: "trust-the-time-lag",
  title: "Which lag number explains the stale reads?",
  simId: "primary-replica-lag",
  question:
    "Early in the incident the replica's time-lag panel looked small, but a byte counter was growing and users saw stale data. Which measurement explains what is happening?",
  prediction: {
    options: [
      { id: "time", label: "The small time lag is a catch-up estimate, so the replica is fine." },
      { id: "bytes", label: "Received WAL that has not been replayed; compare receive and replay positions." },
      { id: "primary", label: "The primary is not committing, so there is nothing to replicate." },
      { id: "endpoint", label: "The reader endpoint is sending reads to the wrong instance." },
    ],
    correctOptionId: "bytes",
    explanation:
      "PostgreSQL reports recent WAL timing in pg_stat_replication, not a prediction of how long the current backlog will take to drain. A small replay_lag can coexist with a large gap between the primary's current WAL position and the standby's replay position. The byte gap, or received-but-not-replayed WAL, is the backlog that makes reads stale.",
  },
  setup: defaults({ writeRate: 6_000, walPerWrite: 8, receiveRate: 60, applyRate: 12, readRate: 4_000 }),
  runFor: 20,
  observe: [
    "The time lag started small while the apply backlog was already growing.",
    "The WAL not yet received stays at zero; transfer is not the bottleneck.",
    "Received but not replayed grows to hundreds of megabytes.",
    "Time lag grows past five seconds and the stale-read rate reaches the read rate.",
    "The primary continues committing at full speed; only replica freshness is affected.",
  ],
  explain:
    "A replica has two separate positions: what it has received and what it has replayed. When replay is slower than generation, bytes accumulate after receipt. Reads see the replayed snapshot, so they remain stale even though the network delivered everything. Time lag is a recent-WAL measurement, so it can lag behind the size of the backlog and then jump when a new transaction is replayed.",
  fix: defaults({ writeRate: 6_000, walPerWrite: 8, receiveRate: 60, applyRate: 60, readRate: 4_000 }),
  debrief:
    "Raising replay capacity above the WAL generation rate drains the backlog. The replica still needs time to catch up, and reads stay stale until it does. A network change would not have helped, because the bytes were already on the replica.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Replication lag is the difference between what the primary has committed and what a replica has made visible to reads. It is not one number. PostgreSQL streaming replication has two stages that matter: the standby receives WAL and writes it, then it replays that WAL into its data files. A replica can receive every byte and still be behind on replay. It can also be missing bytes because the network or receiver cannot keep up. Those are different failures with different fixes.",
  },
  {
    type: "p",
    text: "Time lag and byte lag answer different questions. Time lag approximates how old the most recent replayed transaction is, which is useful for a freshness promise. Byte lag measures how much WAL is outstanding, which is useful for estimating drain time and for spotting a backlog that the time metric hides. PostgreSQL's pg_stat_replication exposes write_lag, flush_lag, and replay_lag, plus the sent, written, flushed, and replayed log sequence numbers. The documentation is explicit that these lag times are measurements of recent WAL, not predictions of how long a standby will take to catch up. A fully caught-up standby can even show a non-zero recent lag for a short time.",
  },
  {
    type: "p",
    text: "Aurora is different at the storage layer, but the same distinction appears in monitoring. AuroraReplicaLag is time-based. OldestReplicationSlotLag is byte-based and reports the lagging replica's WAL volume. A single dashboard line can therefore be healthy while another counter grows.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is primary commit, WAL sender, network, WAL receiver, local WAL write, then replay. Reads on the replica see only the replayed snapshot. A read that arrives after a commit but before replay returns the old value; that is staleness, not corruption. The replica is consistent at its own point in time.",
  },
  {
    type: "diagram",
    id: "replica-lag",
    caption: "Freshness is a position, not a health check. One replica can be current while another is seconds behind.",
  },
  {
    type: "table",
    headers: ["Measure", "Answers", "Can hide"],
    rows: [
      ["Time lag", "How old is the most recent replayed transaction?", "A large byte backlog that has not reached the next transaction"],
      ["Receive gap", "How much WAL has not arrived?", "Replay that is also slower than generation"],
      ["Apply backlog", "How much arrived but is not visible?", "A transfer gap that has not yet become the larger constraint"],
      ["Stale read rate", "How much read traffic can see the gap?", "A low read rate that makes the same lag look harmless"],
    ],
  },
  {
    type: "p",
    text: "The input rate is write rate multiplied by WAL per write. A wide-row update, an index build, or a bulk load can multiply the bytes per transaction without changing the transaction rate. That is how a workload that looked fine at 1,500 writes per second saturates a replica at 6,000 writes per second of the same shape.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Recent-WAL time lag: warning at 2 seconds, critical at 5 seconds. It measures recent WAL, not the time to drain the backlog.",
      "Received but not replayed: the apply backlog, warning at 64MB and critical at 256MB.",
      "WAL not yet received: the transfer gap, which stays at zero when replay is the only bottleneck.",
      "Stale reads: read rate times the share of reads that arrive inside the lag window.",
      "Replay shortfall: WAL generation minus replay capacity, the rate at which the backlog grows.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Replay stall and watch the apply backlog grow while the receive gap stays at zero. Apply Transfer stall and compare which gap grows. Read the two byte metrics before the time lag, then run the experiment.",
  },
  {
    type: "p",
    text: "WAL sizes, transfer rates, lag thresholds, and the ten-second read spread are illustrative teaching values, not PostgreSQL or Aurora guarantees. The shape is the lesson: transfer and replay are separate queues, and time lag is not a drain estimate.",
  },
  { type: "sim", simId: "primary-replica-lag" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary generated WAL faster than the replica could replay it. Every byte arrived, so the receive gap stayed at zero, but the apply backlog grew. Reads on the replica still saw the last replayed snapshot, so they were stale by the time lag. The time metric grew more slowly than the backlog and could have looked acceptable early in the incident.",
  },
  {
    type: "p",
    text: "The transfer-stall preset produced the opposite shape: replay was fast enough, but WAL arrived too slowly, so the receive gap grew and replay had little to apply. The same time-lag number covered two different failures. Only the byte metrics and the receive-versus-replay comparison separated them.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PostgreSQL primary: pg_stat_replication sent_lsn, write_lsn, flush_lsn, replay_lsn, and the write/flush/replay lag intervals.",
      "PostgreSQL standby: pg_last_wal_replay_lsn(), pg_stat_wal_receiver, and the difference between the primary's current WAL position and the replayed position.",
      "Aurora: AuroraReplicaLag in milliseconds and OldestReplicationSlotLag in bytes.",
      "Replica host: CPU, disk write throughput, and I/O latency while replay is behind. Low CPU with growing apply backlog points to I/O or single-threaded replay.",
      "Application: stale reads, read-after-write failures, and the read paths that use the replica.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare WAL receive rate with replay rate, then compare the receive and replay positions. If the bytes are already on the replica, adding network capacity will not help. If the receive gap is the larger one, replay may be idle and the fix is transfer capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Decide which metric matches the promise: time lag for freshness, byte gap for drain time, stale read rate for user impact.",
      "If transfer is behind, check network throughput, receiver I/O, and WAL compression or encryption overhead.",
      "If replay is behind, check replica CPU and I/O, long transactions, index builds, and whether replay is single-threaded.",
      "Reduce WAL generation where possible: batch size, index maintenance, full-page writes, and unnecessary updates.",
      "Route read-after-write traffic to the primary or a consistency mechanism until the backlog drains.",
      "Watch the backlog drain rate, not just the time lag, before declaring recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger replica instance usually helps replay but costs more and may still be limited by single-threaded apply.",
      "More replicas add read capacity but all of them share the same WAL generation rate and can share the same lag.",
      "Synchronous replication bounds the data-loss window but adds commit latency and can reduce write availability.",
      "Routing all reads to the primary removes staleness and moves the load back to the writer.",
      "A time-only alert is cheap but can miss a growing byte backlog; a byte-only alert can page on a gap that never affects reads.",
      "Long-running queries on the replica can conflict with WAL replay; check the standby delay settings and whether queries are being cancelled.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "time-vs-bytes",
    question: "The replica shows 200ms of replay lag, but a byte counter says 2GB is outstanding. How can both be true?",
    difficulty: 3,
    hints: [
      "The time metric measures recent WAL.",
      "The byte counter measures the queue.",
    ],
    answer:
      "They measure different things. replay_lag is the time between flushing recent WAL on the primary and hearing that the standby replayed it. It is a recent-transaction measurement, not a prediction of how long the outstanding backlog will take. The 2GB is the distance between the primary's current WAL position and the standby's replay position. If a large transaction or a burst arrived, the timer can reflect a recent small transaction while the queue is large. I would trust the byte gap for drain time and the time lag for user-visible freshness, and I would check whether the backlog is growing or shrinking.",
    followUps: [
      "Which metric would you alert on for a freshness SLO?",
      "How would you estimate drain time?",
      "Why can a fully caught-up standby show a non-zero lag?",
    ],
    redFlags: [
      "Treats replay_lag as a catch-up estimate.",
      "Ignores the byte gap.",
      "Assumes one metric is always right.",
    ],
    rubric: [
      "Distinguishes recent-WAL timing from backlog.",
      "Names both metrics.",
      "Uses the byte gap for drain time.",
      "Checks direction of the backlog.",
    ],
  },
  {
    id: "apply-or-transfer",
    question: "Replica lag is growing. How do you tell whether transfer or replay is the bottleneck?",
    difficulty: 2,
    hints: [
      "Compare receive and replay positions.",
      "Look at the receive gap and the apply backlog separately.",
    ],
    answer:
      "I would compare the primary's current WAL position with the standby's received position and its replayed position. If received is close to the primary but replay is far behind, replay is the bottleneck. If received is far behind, transfer is the bottleneck. On PostgreSQL I would read pg_stat_replication on the primary and pg_stat_wal_receiver plus the replay LSN on the standby. I would also check replica CPU and I/O: low CPU with a growing apply backlog suggests I/O or single-threaded replay, while a growing receive gap points at the network or receiver. The fix differs, so I would not add resources until I know which queue is growing.",
    followUps: [
      "What does low replica CPU with high lag suggest?",
      "How would a long transaction affect replay?",
      "What would you check on the network path?",
    ],
    redFlags: [
      "Adds replica capacity without checking the queue.",
      "Uses only time lag.",
      "Confuses receive and replay positions.",
    ],
    rubric: [
      "Compares received and replayed positions.",
      "Names the two queues.",
      "Uses CPU and I/O as corroboration.",
      "Chooses a fix per bottleneck.",
    ],
  },
  {
    id: "stale-reads",
    question: "How do you estimate how many reads are stale when replica lag is five seconds?",
    difficulty: 3,
    hints: [
      "Staleness depends on when reads arrive after a write.",
      "Not every read is a read-after-write.",
    ],
    answer:
      "I would start with the read rate and the share of reads that must reflect a recent write. If every write is followed immediately by a read, most of those reads are stale for the duration of the lag. If only a small fraction of reads are read-after-write, the affected rate is much smaller. I would instrument the read-after-write paths, compare the lag with the product's freshness promise, and use the result to decide which paths need the primary or a version boundary. The replica being behind is not the same as every user seeing stale data.",
    followUps: [
      "How would you identify read-after-write paths?",
      "What if the read happens ten seconds after the write?",
      "How would a version token change the estimate?",
    ],
    redFlags: [
      "Multiplies total reads by lag without a read-after-write share.",
      "Assumes all reads are equally sensitive.",
      "Ignores the product promise.",
    ],
    rubric: [
      "Starts from read rate and read-after-write share.",
      "Explains the time window.",
      "Connects to product freshness.",
      "Chooses routing or a consistency mechanism.",
    ],
  },
  {
    id: "choose-metric",
    question: "Which replication metric would you put on a dashboard for a read freshness SLO, and which would you use for capacity planning?",
    difficulty: 3,
    hints: [
      "One metric answers user freshness.",
      "One metric answers how much work is queued.",
    ],
    answer:
      "For a freshness SLO I would use a time-based lag that matches the promise, such as replay_lag or AuroraReplicaLag, and pair it with a stale-read or read-after-write error signal so the dashboard shows user impact. For capacity planning I would use the byte gap and its growth rate: the difference between the primary's WAL position and the replica's replay position. That tells me how much work is queued and how fast replay must run to drain it. I would also track WAL generation rate, because a change in write shape can break a replica that was sized for the old rate.",
    followUps: [
      "What would you alert on at 3am?",
      "Why not alert on both at the same severity?",
      "How does WAL per write change the answer?",
    ],
    redFlags: [
      "Uses a single metric for both jobs.",
      "Ignores WAL generation rate.",
      "Alerts on a raw byte count without a time bound.",
    ],
    rubric: [
      "Pairs time lag with user impact.",
      "Uses byte gap for capacity.",
      "Includes generation rate.",
      "Separates alerting from planning.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The read freshness promise is written per workload, not as one global number.",
      "Dashboards show time lag, byte gap, and WAL generation rate together.",
      "The team knows whether its replica is limited by transfer or replay.",
      "Read-after-write paths are identified and can be routed to the primary.",
      "Replica CPU, disk, and network are monitored alongside lag.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare received and replayed positions before adding capacity.",
      "Check whether the backlog is growing or draining.",
      "Check for a WAL burst from a bulk load, index build, or wide-row update.",
      "Route freshness-sensitive reads away from the lagging replica.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record whether transfer or replay was the bottleneck and why.",
      "Adjust the replica size or WAL generation rate with the drain rate in mind.",
      "Recheck the stale-read estimate against the actual product impact.",
      "Update the freshness alert to use the metric that matches the promise.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: The Cumulative Statistics System",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "pg_stat_replication lag columns and the warning that they measure recent WAL, not catch-up time.",
  },
  {
    title: "PostgreSQL: Log-Shipping Standby Servers",
    url: "https://www.postgresql.org/docs/current/warm-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Streaming replication, WAL receiver, and replay on a standby.",
  },
  {
    title: "Monitoring read replication",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.Monitoring.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "RDS ReplicaLag and the engine-specific view of read replica delay.",
  },
  {
    title: "Amazon CloudWatch metrics for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AuroraReplicaLag, AuroraGlobalDBRPOLag, and OldestReplicationSlotLag units and scope.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "primary-replica-lag": {
      model: replicaLagModel,
      presets,
      instructions:
        "Start healthy. Apply Replay stall and watch the apply backlog grow while the receive gap stays at zero. Apply Transfer stall and compare which queue grows. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. WAL rates, thresholds, and the read-spread assumption are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-read-replica-routing",
    "databases-replication-threads",
    "databases-read-replica-cold",
  ],
};
