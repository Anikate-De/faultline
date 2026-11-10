import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "currentLag",
    label: "Starting lag",
    min: 0,
    max: 300,
    step: 5,
    value: 0,
    unit: "s",
    group: "Replication",
    help: "How far the replica is behind when the scenario begins. Lag is a backlog of writes, not just a number on a dashboard.",
    format: "number" as const,
  },
  {
    id: "burstRps",
    label: "Primary write rate",
    min: 500,
    max: 50_000,
    step: 500,
    value: 1_500,
    unit: " txn/s",
    group: "Workload",
    help: "Transactions committed per second on the primary. Each one produces write-ahead log that the replica must apply.",
    format: "rps" as const,
  },
  {
    id: "applyThreads",
    label: "Apply threads",
    min: 1,
    max: 32,
    step: 1,
    value: 8,
    unit: "",
    group: "Replica",
    help: "Parallel apply workers in this model. PostgreSQL physical streaming replication applies WAL in one startup process; logical replication can use parallel workers.",
    format: "count" as const,
  },
  {
    id: "applyMsPerTxn",
    label: "Apply cost per transaction",
    min: 0.5,
    max: 20,
    step: 0.5,
    value: 4,
    unit: " ms",
    group: "Replica",
    help: "Time one apply worker spends per transaction, including index maintenance and page reads. Higher cost lowers apply throughput.",
    format: "ms" as const,
  },
  {
    id: "ioEfficiency",
    label: "Apply I/O efficiency",
    min: 10,
    max: 100,
    step: 10,
    value: 80,
    unit: "%",
    group: "Replica",
    help: "How much of the worker's nominal throughput survives I/O stalls. A cold cache or slow volume lowers it.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  lag: number;
  burst: number;
  threads: number;
  applyMs: number;
  io: number;
  capacity: number;
  lagGrowth: number;
  applyUtilization: number;
  cpu: number;
  health: Health;
}

function compute(p: Params, lag: number): Computed {
  const burst = Math.max(1, num(p, "burstRps", 1_500));
  const threads = Math.max(1, num(p, "applyThreads", 8));
  const applyMs = Math.max(0.1, num(p, "applyMsPerTxn", 4));
  const io = clamp(num(p, "ioEfficiency", 80) / 100, 0.1, 1);
  const capacity = threads * (1_000 / applyMs) * io;
  const lagGrowth = 1 - capacity / burst;
  const applyUtilization = (capacity / burst) * 100;
  const cpu = clamp(threads / 32) * 100;
  const health: Health = lag >= 90 ? "crit" : lag >= 30 ? "warn" : "ok";
  return { lag, burst, threads, applyMs, io, capacity, lagGrowth, applyUtilization, cpu, health };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["replica-lag", values.lag, 0.2],
    ["lag-growth", Math.max(0, values.lagGrowth), 0.01],
    ["apply-capacity", values.capacity, 1],
    ["replica-cpu", values.cpu, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, lag: number, seed: number, t: number): SimFrame {
  const values = compute(p, lag);
  return {
    t,
    nodes: [
      {
        id: "primary",
        label: "Primary",
        kind: "db",
        role: "primary",
        health: "ok",
        sublabel: `${formatCount(values.burst)} txn/s`,
        detail:
          "The primary commits and writes WAL. It can produce a burst faster than a replica can replay it, even when the network delivers every record.",
        meta: { view: "replication" },
      },
      {
        id: "replica",
        label: "Replica · apply path",
        kind: "db",
        role: "replica",
        health: values.health,
        utilization: clamp(values.cpu / 100),
        sublabel: `${values.lag.toFixed(1)}s behind · CPU ${Math.round(values.cpu)}%`,
        detail: `The replica can apply about ${formatCount(values.capacity)} txn/s with ${values.threads} worker(s) and ${Math.round(
          values.io * 100,
        )}% I/O efficiency. CPU is low because the bottleneck is the apply path, not the CPU.`,
        meta: { view: "replication", lag: values.lag, capacity: values.capacity },
      },
    ],
    edges: [edge("primary-replica", "primary", "replica", clamp(values.capacity / values.burst), values.health, "WAL apply")],
    metrics: [
      metric("replica-lag", "Replica apply lag", values.lag, "s", 30, 90, "number"),
      metric("lag-growth", "Lag growth", Math.max(0, values.lagGrowth), " s/s", 0.1, 0.5, "number"),
      metric("apply-capacity", "Apply capacity", values.capacity, " txn/s", undefined, undefined, "rps"),
      metric("replica-cpu", "Replica CPU", values.cpu, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Lag ${values.lag.toFixed(1)}s; apply capacity ${formatCount(values.capacity)} txn/s against ${formatCount(
      values.burst,
    )} txn/s; CPU ${Math.round(values.cpu)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replica-lag",
    metricId: "replica-lag",
    warn: 30,
    crit: 90,
    title: "Replica apply lag is beyond the recovery budget",
    cause:
      "The replica applies transactions more slowly than the primary produces them. The backlog grows even with a healthy network, and read freshness or failover RPO pays for it.",
    fix:
      "Raise apply throughput: more apply workers where the engine supports them, a faster volume, fewer indexes on the replica, or a lower write burst. Adding replicas does not make one apply path faster.",
    checkFirst: [
      "Compare apply capacity with the primary write rate.",
      "Check replica CPU, I/O latency, and page cache hit rate.",
      "Check for long-running queries on the replica that compete with apply.",
    ],
  },
  {
    id: "lag-growth",
    metricId: "lag-growth",
    warn: 0.1,
    crit: 0.5,
    title: "The lag backlog is growing, not draining",
    cause:
      "Apply capacity is below the write rate. Every second of real time adds a fraction of a second to the backlog until the replica falls too far behind to catch up on its own.",
    fix:
      "Increase apply throughput or reduce the burst. If the replica cannot catch up, rebuild or re-seed it rather than waiting for the gap to close.",
    checkFirst: [
      "Read lag and lag growth together; a steady lag with zero growth is different from a growing backlog.",
      "Check whether the replica is also serving reads that slow apply.",
      "Check replication slot and WAL retention on the primary.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const replicationModel: SimModel = {
  id: "databases-replication-threads",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed, 0);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const t = frame.t + dt;
    const first = frame.flags.stateInit !== 1;
    const previousLag = first ? Math.max(0, num(p, "currentLag", 0)) : Number(frame.flags.lag ?? 0);
    const provisional = compute(p, previousLag);
    const lag = clamp(previousLag + provisional.lagGrowth * dt, 0, 3_600);
    const values = compute(p, lag);
    const next = buildFrame(p, lag, seed, t);
    next.flags = { ...frame.flags, ...next.flags, lag, stateInit: 1 };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.lag >= 90 && frame.flags.lagLogged !== 1) {
      pushEvent(next, {
        id: "apply-bottleneck",
        at: t,
        severity: "crit",
        title: "Replica cannot apply the write burst",
        detail: `${formatCount(values.capacity)} txn/s of apply capacity against ${formatCount(
          values.burst,
        )} txn/s of writes; lag is ${values.lag.toFixed(1)}s and CPU is only ${Math.round(values.cpu)}%.`,
        nodeId: "replica",
        metricId: "replica-lag",
      });
    }
    next.flags.lagLogged = values.lag >= 90 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const lag = frame.flags.stateInit === 1 ? Number(frame.flags.lag ?? 0) : num(p, "currentLag", 0);
    const values = compute(p, lag);
    return [
      `Apply capacity is about ${formatCount(values.capacity)} txn/s: ${values.threads} threads × ${formatCount(
        1_000 / values.applyMs,
      )} txn/s each × ${Math.round(values.io * 100)}% I/O efficiency.`,
      values.lagGrowth > 0
        ? `Writes arrive at ${formatCount(values.burst)} txn/s, so the backlog grows by ${values.lagGrowth.toFixed(
            2,
          )}s every second. Lag is a queue, not a fixed property of the replica.`
        : `Writes arrive at ${formatCount(values.burst)} txn/s, below apply capacity, so the backlog drains instead of growing.`,
      `Replica CPU is ${Math.round(values.cpu)}%. Low CPU is consistent with an apply path that is waiting on I/O or running too few workers; it is not evidence that the replica is healthy.`,
      "Physical PostgreSQL replication replays WAL in one startup process. More replicas copy the same apply bottleneck; they do not divide the work of one replay stream.",
      "A replica that also serves reads competes with apply for I/O and cache. Moving read traffic away can let the same apply path catch up.",
    ];
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
    description: "Apply capacity is above the write rate, so the replica keeps up and lag stays near zero.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Write burst",
    description: "A 3,000 txn/s burst outruns 1,600 txn/s of apply capacity; lag grows steadily into warning.",
    tone: "warn",
    elapsed: 20,
    params: defaults({ currentLag: 10, burstRps: 3_000, applyThreads: 8, applyMsPerTxn: 4, ioEfficiency: 80 }),
  },
  {
    id: "failure",
    label: "Apply bottleneck",
    description: "Two apply workers on a slow volume fall behind a 12,000 txn/s burst while replica CPU stays low.",
    tone: "crit",
    elapsed: 40,
    params: defaults({ currentLag: 55, burstRps: 12_000, applyThreads: 2, applyMsPerTxn: 8, ioEfficiency: 50 }),
  },
  {
    id: "threads",
    label: "More apply threads",
    description: "Thirty-two workers and better I/O raise apply capacity above a 6,000 txn/s burst.",
    tone: "ok",
    params: defaults({ currentLag: 20, burstRps: 6_000, applyThreads: 32, applyMsPerTxn: 3, ioEfficiency: 90 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The burst ends, apply capacity exceeds the write rate, and the backlog drains to zero.",
    tone: "ok",
    params: defaults({ currentLag: 20, burstRps: 1_000, applyThreads: 8, applyMsPerTxn: 4, ioEfficiency: 80 }),
  },
];

const experiment: Experiment = {
  id: "cpu-idle-lag-growing",
  title: "Why lag grows while replica CPU is idle",
  simId: "replication-threads",
  question:
    "The replica shows 6% CPU, the network is healthy, and lag is climbing during a 12,000 transaction/s burst. What is the bottleneck?",
  prediction: {
    options: [
      { id: "cpu", label: "The replica needs more CPU; six percent is too low." },
      { id: "network", label: "The network is dropping WAL records between Regions." },
      { id: "apply", label: "The apply path cannot replay transactions as fast as the primary produces them." },
      { id: "storage", label: "The primary's storage volume is too small." },
    ],
    correctOptionId: "apply",
    explanation:
      "Low CPU with growing lag points away from compute saturation. The apply path is limited by worker count, per-transaction work, and I/O, so it consumes little CPU while falling behind. The network is not the bottleneck if the replica has the WAL but cannot replay it. Adding replicas copies the same apply capacity rather than increasing it.",
  },
  setup: defaults({ currentLag: 55, burstRps: 12_000, applyThreads: 2, applyMsPerTxn: 8, ioEfficiency: 50 }),
  runFor: 40,
  observe: [
    "Apply capacity is about 125 txn/s against a 12,000 txn/s write rate.",
    "Lag grows by almost one second per second of real time.",
    "Replica CPU stays near 6% while the lag threshold goes critical.",
    "Thirty-two workers and better I/O raise capacity above the burst and drain the backlog.",
  ],
  explain:
    "Replication has two separate capacities: the network can deliver WAL, and the replica can apply it. The apply path is often the smaller one. A low CPU reading does not rule out an apply bottleneck, because the worker may be waiting on I/O or there may be only one worker. To fix it, raise apply throughput or reduce the write rate; do not add replicas.",
  fix: defaults({ currentLag: 55, burstRps: 12_000, applyThreads: 32, applyMsPerTxn: 2, ioEfficiency: 100 }),
  debrief:
    "With 32 workers at 2 ms and full I/O efficiency, apply capacity reaches 16,000 txn/s against 12,000 txn/s of writes, so lag drains even though CPU is higher. The replica is doing more work, not less. The tradeoff is more workers competing for the same I/O and cache, which is why the fix has to be measured.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Replication has a send side and an apply side. The primary writes WAL, a WAL sender ships it, and the replica receives and replays it. Apply lag is the delay between the primary's commit and the replica's replay. It is a queue: if the replica applies transactions more slowly than the primary produces them, the backlog grows even when the network is perfect.",
  },
  {
    type: "p",
    text: "Apply capacity is not the same as CPU capacity. A worker can be idle on CPU while waiting for a disk page, an index update, or a lock. PostgreSQL physical streaming replication replays WAL in a single startup process, so a replica can be far behind while the host has many idle cores. Logical replication can use parallel apply workers in newer versions, but the principle is the same: the apply path has its own ceiling.",
  },
  {
    type: "p",
    text: "The growth rate is easy to reason about. If apply capacity is 1,600 transactions per second and the primary produces 3,000, the backlog grows by about 1.46 seconds every second. If apply capacity exceeds the write rate, the backlog drains. Lag at one instant is less informative than lag plus its direction.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "On the primary, the WAL sender reads the log. On the replica, the startup process or apply workers replay records into pages and indexes. Reads served by the replica compete with that work for I/O and cache. A slow volume, a cold cache, many indexes, or a long-running read can all reduce apply throughput without moving CPU.",
  },
  {
    type: "table",
    headers: ["Signal", "What it suggests", "What it does not prove"],
    rows: [
      ["Lag growing, CPU low", "Apply or I/O bottleneck", "That the host needs more CPU"],
      ["Lag growing, CPU high", "Apply is CPU-bound or competing with reads", "That the network is fine"],
      ["Lag flat, CPU low", "Steady state or no writes", "That the replica is current"],
      ["WAL sender behind", "Network or sender limit", "That apply is the problem"],
      ["Replica I/O wait high", "Storage or cache pressure", "That adding replicas helps"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replica apply lag: warning at 30 seconds and critical at 90 in this model.",
      "Lag growth in seconds per second: warning above 0.1 and critical above 0.5.",
      "Apply capacity in transactions per second, computed from workers, per-transaction cost, and I/O efficiency.",
      "Replica CPU, which can stay low while lag grows.",
      "A thread-count slider, which changes apply capacity without changing the primary write rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Apply bottleneck. Compare apply capacity with the write rate and read the lag direction before the absolute lag. Raise apply threads, then lower I/O efficiency, to see which lever matters. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Worker counts, per-transaction costs, and lag thresholds are illustrative teaching values. Real apply capacity depends on the engine, the replication method, the volume, the number of indexes, and the read workload on the replica.",
  },
  { type: "sim", simId: "replication-threads" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Two apply workers at 8 ms per transaction on 50% I/O efficiency could replay about 125 transactions per second. The primary produced 12,000, so the backlog grew by nearly a second every second. Replica CPU stayed around 6%, which is exactly what an I/O-bound or under-threaded apply path looks like. Lag crossed 90 seconds while the host looked idle.",
  },
  {
    type: "p",
    text: "Raising the worker count and improving I/O efficiency moved apply capacity above the write rate. Lag drained instead of growing. CPU rose because the replica was doing more work, not because CPU had been the original bottleneck.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PostgreSQL: pg_stat_replication on the primary for write_lag, flush_lag, and replay_lag; pg_last_wal_replay_lsn and pg_stat_wal_receiver on the replica.",
      "Replica I/O latency, read IOPS, and cache hit ratio; apply is often limited by random reads and index maintenance.",
      "Replica CPU and runnable workers, which can be low while apply waits on storage.",
      "Long queries on the replica, which compete with replay and can hold back cleanup.",
      "Primary WAL generation and replication slot retention, which show whether the backlog is growing or being retained.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare apply capacity with the write rate and check whether lag is growing or draining. If CPU is low and lag is growing, look at worker count, I/O latency, and competing reads. Adding replicas copies the bottleneck; it does not raise apply throughput.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure apply throughput and the primary write rate over the same window.",
      "Check whether the replica is waiting on I/O, a lock, or a single worker.",
      "Raise apply parallelism where the engine supports it, and use a faster volume or cache.",
      "Reduce per-transaction apply cost: fewer indexes, smaller transactions, or a less write-heavy workload.",
      "Move read traffic off the replica if it competes with replay.",
      "If the gap is too large to catch up, rebuild or re-seed the replica instead of waiting.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More apply workers raise throughput but compete for the same I/O and can increase contention.",
      "A faster volume reduces apply time but costs more and may not help a CPU-bound replay.",
      "Fewer indexes speed up apply but slow the replica's read queries.",
      "Rebuilding a replica restores a clean state but takes time and I/O on the primary.",
      "Serving reads on the replica improves read capacity but can lengthen apply lag.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "low-cpu-lag",
    question: "Replica CPU is 8%, network is healthy, and lag is growing. How do you diagnose it?",
    difficulty: 3,
    hints: [
      "Separate send capacity from apply capacity.",
      "Look at I/O and worker count, not CPU.",
    ],
    answer:
      "I would compare the primary write rate with the replica's apply throughput and check whether lag is growing or flat. Low CPU with growing lag points to the apply path: too few workers, high per-transaction cost, or I/O stalls. I would check pg_stat_replication for replay_lag, the replica's I/O latency and cache hit rate, and any long reads competing with replay. Adding replicas would not help because each one has the same apply bottleneck.",
    followUps: [
      "Which PostgreSQL view shows replay lag?",
      "What would change if CPU were high?",
      "When would you rebuild the replica?",
    ],
    redFlags: [
      "Adds replicas first.",
      "Blames the network without checking.",
      "Assumes low CPU means healthy.",
    ],
    rubric: [
      "Separates send and apply.",
      "Checks I/O and workers.",
      "Uses replication views.",
      "Avoids adding replicas.",
    ],
  },
  {
    id: "parallel-apply",
    question: "When can you use parallel apply, and what limits it?",
    difficulty: 3,
    hints: [
      "Physical versus logical replication.",
      "Parallelism still shares I/O and dependencies.",
    ],
    answer:
      "PostgreSQL physical streaming replication replays WAL in a single startup process, so there is no parallel apply knob for the physical stream. Logical replication can use parallel apply workers in newer versions, but only for transactions that can be applied independently; dependencies and conflicts limit it. Even with more workers, I/O, index maintenance, and the replica's read workload set the real ceiling. I would measure apply throughput before and after changing parallelism.",
    followUps: [
      "What is a logical replication conflict?",
      "How would you measure apply throughput?",
      "What does Aurora do differently?",
    ],
    redFlags: [
      "Assumes physical replication is parallel.",
      "Adds workers without measuring I/O.",
      "Ignores dependencies.",
    ],
    rubric: [
      "Distinguishes physical and logical.",
      "Names dependency limits.",
      "Mentions I/O.",
      "Measures the result.",
    ],
  },
  {
    id: "catch-up",
    question: "A replica is 40 minutes behind and falling further behind. Do you wait or rebuild?",
    difficulty: 3,
    hints: [
      "Compare apply capacity with the write rate.",
      "A backlog can outlive the incident.",
    ],
    answer:
      "I would compare apply capacity with the current write rate. If apply capacity is above the write rate, the backlog will drain and I can estimate how long it will take. If it is below, waiting makes the gap larger, so I would reduce the write rate, increase apply throughput, or rebuild from a snapshot. I would also check whether the replica is serving reads that slow replay, and whether the primary is retaining WAL for the slot.",
    followUps: [
      "How do you estimate drain time?",
      "What are the risks of rebuilding?",
      "What happens to WAL retention while lag grows?",
    ],
    redFlags: [
      "Waits without comparing rates.",
      "Rebuilds without checking the cause.",
      "Ignores WAL retention.",
    ],
    rubric: [
      "Compares the two rates.",
      "Estimates drain or decides to rebuild.",
      "Checks competing reads.",
      "Checks WAL retention.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Apply throughput and primary write rate are charted together.",
      "Lag alerts include direction, not just the absolute value.",
      "Replica I/O latency, cache hit rate, and worker count are visible.",
      "Read traffic on replicas is sized against apply capacity.",
      "A rebuild path and its time are documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare apply capacity with the write rate.",
      "Check I/O and worker count before adding replicas.",
      "Move competing reads off the replica if possible.",
      "Estimate drain time or start a rebuild before the gap grows further.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the apply ceiling and the write burst that exceeded it.",
      "Retune indexes, workers, and replica reads with the measured result.",
      "Test the replica under a production-like write burst.",
      "Update the lag alarm with the observed growth rate.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Log-Shipping Standby Servers",
    url: "https://www.postgresql.org/docs/current/warm-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Streaming replication, WAL replay, and the single startup process that applies physical replication.",
  },
  {
    title: "PostgreSQL: Replication Configuration",
    url: "https://www.postgresql.org/docs/current/runtime-config-replication.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "WAL sender and receiver settings, worker limits, and replication timeouts.",
  },
  {
    title: "Amazon Aurora replication",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Replication.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How Aurora replicas read shared storage and where replica lag comes from.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "replication-threads": {
      model: replicationModel,
      presets,
      instructions:
        "Start healthy, apply Apply bottleneck, and compare apply capacity with the write rate. Watch lag direction, then raise apply threads and I/O efficiency. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Worker counts, per-transaction costs, and thresholds are teaching values, not engine limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-primary-replica-lag",
    "databases-read-replica-cold",
    "databases-cross-region-rpo",
    "databases-long-transactions",
  ],
};
