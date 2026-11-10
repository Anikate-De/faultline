import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 4;
const SHARD_CAPACITY = 10_000;
const SHARED_IO_MBPS = 250;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "balancerOn",
    label: "Balancer",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "1 means the balancer is enabled. MongoDB enables it by default; a disabled balancer stops new range migrations but leaves existing imbalance in place.",
    format: "count",
  },
  {
    id: "imbalanceMB",
    label: "Data imbalance",
    min: 0,
    max: 2_400,
    step: 50,
    value: 120,
    unit: " MB",
    group: "Distribution",
    help: "Modeled difference in collection data between the fullest and emptiest shard. MongoDB treats a collection as balanced while the difference stays below three times the configured range size.",
    format: "number",
  },
  {
    id: "migrationRate",
    label: "Migration rate",
    min: 0,
    max: 12,
    step: 1,
    value: 2,
    unit: " chunks/min",
    group: "Policy",
    help: "Ranges the balancer may move per minute once it decides to act. A shard participates in at most one migration at a time, so this is a teaching rate rather than a hard cluster limit.",
    format: "count",
  },
  {
    id: "chunkSizeMB",
    label: "Range size",
    min: 32,
    max: 256,
    step: 16,
    value: 128,
    unit: " MB",
    group: "Distribution",
    help: "Configured maximum range size. MongoDB's documented default is 128 MB; the balancing threshold is three times this value.",
    format: "number",
  },
  {
    id: "traffic",
    label: "Application traffic",
    min: 5_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Reads and writes spread across the shards. Application I/O shares the same disks and network as migration.",
    format: "rps",
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
  balancerOn: boolean;
  thresholdMB: number;
  moving: boolean;
  remainingMB: number;
  migrationMBps: number;
  appMBps: number;
  ioUtil: number;
  p99: number;
  traffic: number;
  maxCpu: number;
  cpu: number[];
  shardHealth: Health[];
}

function compute(p: Params, t: number): Computed {
  const balancerOn = num(p, "balancerOn", 1) >= 0.5;
  const imbalance = clamp(num(p, "imbalanceMB", 120), 0, 2_400);
  const rate = clamp(num(p, "migrationRate", 2), 0, 12);
  const chunk = clamp(num(p, "chunkSizeMB", 128), 32, 256);
  const traffic = clamp(num(p, "traffic", 12_000), 0, 40_000);
  const thresholdMB = 3 * chunk;
  const canMove = balancerOn && rate > 0 && imbalance > thresholdMB;
  const moved = canMove ? Math.min(imbalance, (Math.max(0, t) / 60) * rate * chunk) : 0;
  const remainingMB = Math.max(0, imbalance - moved);
  const moving = canMove && remainingMB > thresholdMB;
  const effectiveRate = moving ? rate : 0;
  const migrationMBps = (effectiveRate / 60) * chunk;
  const appMBps = traffic * 0.0015;
  const ioUtil = clamp((migrationMBps * 2 + appMBps) / SHARED_IO_MBPS);
  const queue = Math.min(0.97, ioUtil);
  const p99 = Math.min(MAX_P99_MS, 4 + (140 * queue) / (1 - queue) + migrationMBps * 0.6);
  const baseCpu = (traffic / SHARD_COUNT / SHARD_CAPACITY) * 100;
  const migrationCpu = migrationMBps * 1.2;
  const cpu = Array.from({ length: SHARD_COUNT }, (_, index) =>
    clamp(index < 2 ? baseCpu + migrationCpu : baseCpu, 0, 100),
  );
  const combined: Health =
    p99 >= 150 || ioUtil >= 0.9 || Math.max(...cpu) >= 90
      ? "crit"
      : p99 >= 50 || ioUtil >= 0.7 || Math.max(...cpu) >= 70
        ? "warn"
        : "ok";
  const shardHealth = cpu.map((value, index) =>
    index < 2 ? combined : value >= 90 ? "crit" : value >= 70 ? "warn" : "ok",
  );
  return {
    balancerOn,
    thresholdMB,
    moving,
    remainingMB,
    migrationMBps,
    appMBps,
    ioUtil,
    p99,
    traffic,
    maxCpu: Math.max(...cpu),
    cpu,
    shardHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const nodes: SimNode[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const involved = values.moving && index < 2;
    return {
      id: `shard-${index}`,
      label: `Shard ${index}`,
      kind: "db" as const,
      role: "shard" as const,
      health: values.shardHealth[index],
      utilization: clamp(values.cpu[index] / 100),
      throughput: values.traffic / SHARD_COUNT,
      sublabel: involved
        ? `${index === 0 ? "donor" : "recipient"} · ${values.migrationMBps.toFixed(0)} MB/s`
        : `${(values.traffic / SHARD_COUNT).toFixed(0)} ops/s`,
      detail: involved
        ? "This shard is part of the active range migration. The donor reads and the recipient writes while both continue to serve application requests."
        : "A shard outside the active migration. Its load comes from application traffic only.",
      meta: {
        view: "shards",
        cpu: values.cpu[index],
        memory: 8,
        hot: values.shardHealth[index] === "crit" ? 1 : 0,
      },
    };
  });
  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("query-p99", "Application p99", values.p99, "ms", 50, 150, "ms"),
      metric("io-util", "Shared I/O utilization", values.ioUtil * 100, "%", 70, 90, "percent"),
      metric("hot-shard-cpu", "Hottest shard CPU", values.maxCpu, "%", 70, 90, "percent"),
      metric("imbalance-ratio", "Imbalance over threshold", values.remainingMB / values.thresholdMB, "x", 1, 2, "number"),
      metric("migration-mbps", "Migration throughput", values.migrationMBps, " MB/s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, moving: values.moving ? 1 : 0, balancerOn: values.balancerOn ? 1 : 0 },
    summary: `${values.moving ? "Balancing" : "Not balancing"} · imbalance ${values.remainingMB.toFixed(0)} MB · shared I/O ${(values.ioUtil * 100).toFixed(0)}% · p99 ${values.p99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 7)) / 2.4);
  for (const [id, value] of [
    ["query-p99", values.p99],
    ["io-util", values.ioUtil * 100],
    ["hot-shard-cpu", values.maxCpu],
    ["imbalance-ratio", values.remainingMB / values.thresholdMB],
    ["migration-mbps", values.migrationMBps],
  ] as const) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  values.cpu.forEach((cpu, index) => {
    frame.series[`cpu.shard-${index}`] = Array.from({ length: 24 }, (_, point) => Math.max(0, cpu * jitter(point)));
  });
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-p99",
    metricId: "query-p99",
    warn: 50,
    crit: 150,
    title: "Balancing is inflating application latency",
    cause:
      "The balancer is copying ranges while application traffic uses the same shards. The donor reads, the recipient writes, and both compete for disk and network with user requests. Latency rises before the data is more evenly distributed.",
    fix:
      "Stop or throttle migrations during peak, or move balancing into a window. If the cluster is already saturated without migrations, fix capacity or the hot key first; the balancer cannot compensate for a shard that is hot within one range.",
    checkFirst: [
      "Check whether p99 rose on the donor and recipient at the same time migration started.",
      "Check balancer state, migration rate, and range size before changing application settings.",
      "Check per-shard CPU and I/O to separate migration cost from an unrelated hot key.",
    ],
  },
  {
    id: "io-util",
    metricId: "io-util",
    warn: 70,
    crit: 90,
    title: "Shared storage is saturated during the rebalance",
    cause:
      "Each moved range is read from the donor and written to the recipient. At a high migration rate or large range size, that traffic crowds out application reads and writes even when the shards have spare CPU.",
    fix:
      "Lower the migration rate, use a balancing window, or add I/O headroom. Throttling extends the time the cluster stays imbalanced, so decide which risk matters during the current traffic period.",
    checkFirst: [
      "Check device I/O utilization and latency on the donor and recipient.",
      "Compare migration bytes per second with application bytes per second.",
      "Check whether a single shard is participating in repeated migrations.",
    ],
  },
  {
    id: "hot-shard-cpu",
    metricId: "hot-shard-cpu",
    warn: 70,
    crit: 90,
    title: "The busiest shard is saturated",
    cause:
      "Application traffic is concentrated on the busiest shard, and an active migration adds copy work to the donor or recipient. Cluster capacity is set by the hottest shard, not the average.",
    fix:
      "Reduce traffic on the hot range, add capacity, or rebalance during a window. If chunk counts are already even, inspect the shard key and hot keys; moving ranges may not split one key's load.",
    checkFirst: [
      "Check per-shard CPU rather than the cluster average.",
      "Check whether the hot shard is the donor or recipient of a migration.",
      "Check for a hot key or monotonic shard key inside the range.",
    ],
  },
  {
    id: "imbalance-ratio",
    metricId: "imbalance-ratio",
    warn: 1,
    crit: 2,
    title: "The collection remains materially imbalanced",
    cause:
      "The balancer is off, below its migration threshold, or moving slowly. MongoDB treats a collection as balanced while the data difference stays under three times the configured range size; an imbalance above that leaves one shard carrying more data and often more read load.",
    fix:
      "Enable the balancer in a controlled window, or raise the migration rate after peak. Do not disable balancing indefinitely: the next rebalance becomes larger and more expensive.",
    checkFirst: [
      "Check whether the balancer is enabled and inside its active window.",
      "Check the configured range size and the data difference between shards.",
      "Check whether the imbalance is growing because of a monotonic write pattern.",
    ],
  },
];

export const balancerModel: SimModel = {
  id: "mongodb-balancer",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    if (values.moving && !Number(next.flags.migrationAnnounced ?? 0)) {
      pushEvent(next, {
        id: "balancer-migration-started",
        at: frame.t,
        severity: values.p99 >= 150 ? "crit" : values.p99 >= 50 ? "warn" : "info",
        title: "The balancer started moving a range",
        detail: `${values.migrationMBps.toFixed(0)} MB/s is being copied while application traffic continues. Shared I/O is ${(values.ioUtil * 100).toFixed(0)}%.`,
        nodeId: "shard-0",
        metricId: "query-p99",
      });
      next.flags.migrationAnnounced = 1;
    }
    if (!values.moving && Number(frame.flags.moving ?? 0) === 1 && !Number(next.flags.migrationDone ?? 0)) {
      pushEvent(next, {
        id: "balancer-migration-finished",
        at: frame.t,
        severity: "info",
        title: "Balancing stopped",
        detail: `The data difference is now ${values.remainingMB.toFixed(0)} MB, below or near the ${values.thresholdMB.toFixed(0)} MB migration threshold. Application I/O is no longer sharing capacity with a copy.`,
      });
      next.flags.migrationDone = 1;
    }
    if (!values.moving) next.flags.migrationAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0);
    return [
      values.moving
        ? `The balancer is moving ${values.migrationMBps.toFixed(0)} MB/s. The donor reads and the recipient writes, so modeled shared I/O is ${(values.ioUtil * 100).toFixed(0)}% of ${SHARED_IO_MBPS} MB/s.`
        : `No migration is running. The data difference is ${values.remainingMB.toFixed(0)} MB against a ${values.thresholdMB.toFixed(0)} MB balancing threshold, so the balancer is deliberately leaving the collection alone.`,
      `Application traffic contributes about ${values.appMBps.toFixed(0)} MB/s of I/O. Migration adds to that rather than replacing it, which is why turning balancing on during peak can raise p99 before distribution improves.`,
      `The busiest shard is at ${values.maxCpu.toFixed(0)}% of its illustrative CPU capacity. Cluster capacity follows the hottest shard, not the average.`,
      "Illustrative model. Migration cost, shard capacity, and the latency curve are teaching values; MongoDB documents the balancing threshold as three times the configured range size and limits each shard to one migration at a time.",
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
    description: "The collection is inside its balancing threshold, so the balancer is enabled but idle.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Traffic is high and the imbalance is still below the migration threshold; the hottest shard is saturated.",
    tone: "warn",
    params: defaults({ traffic: 32_000, imbalanceMB: 300, migrationRate: 4 }),
  },
  {
    id: "failure",
    label: "Balance during peak",
    description: "A large imbalance and a high migration rate compete with production I/O at peak.",
    tone: "crit",
    params: defaults({ traffic: 24_000, imbalanceMB: 1_200, migrationRate: 10, chunkSizeMB: 256 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The imbalance is below the threshold and application traffic has returned to normal.",
    tone: "ok",
    params: defaults({ traffic: 14_000, imbalanceMB: 200, migrationRate: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-balance-window",
  title: "Predict what happens when you balance during peak",
  simId: "balancer",
  question:
    "The cluster is imbalanced, p99 is already elevated, and traffic is at peak. You enable the balancer with a high migration rate. What happens first?",
  prediction: {
    options: [
      { id: "improves", label: "p99 improves immediately because writes spread across more shards" },
      { id: "worse", label: "p99 gets worse while ranges are copied, then improves after balancing finishes" },
      { id: "flat", label: "p99 stays flat because the balancer only changes metadata" },
      { id: "reads", label: "Only reads fail; writes are unaffected because the balancer does not touch the write path" },
    ],
    correctOptionId: "worse",
    explanation:
      "A range migration copies documents from the donor to the recipient and catches up on changes. That work shares disk and network with application traffic, so p99 rises during the copy. Distribution improves only after ranges move, and the benefit arrives later than the cost.",
  },
  setup: defaults({ traffic: 24_000, imbalanceMB: 1_200, migrationRate: 10, chunkSizeMB: 256 }),
  runFor: 10,
  observe: [
    "Shared I/O utilization rises as the copy starts.",
    "p99 rises on the donor and recipient before the imbalance falls.",
    "The remaining imbalance decreases only as ranges complete.",
    "Turning the balancer off or lowering the rate removes the copy cost but leaves the imbalance.",
  ],
  explain:
    "The balancer is a background data mover. It does not split load inside a range, and it does not add capacity. When it copies a range, the donor reads and the recipient writes while both continue to serve users. At peak, the copy competes with the workload that is already using the same I/O. A balancing window or a lower migration rate shifts that work to a period with more headroom.",
  fix: defaults({ traffic: 14_000, imbalanceMB: 200, migrationRate: 2, chunkSizeMB: 128 }),
  debrief:
    "Check whether the latency rise began with migration activity on the donor and recipient. If it did, stop or throttle balancing and schedule a window. If the hot shard remains hot with even chunk counts, inspect the shard key and hot keys; moving ranges will not split one key's traffic. Leaving the balancer off forever trades a short latency spike for a larger, more expensive rebalance later.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The MongoDB balancer is a background process that compares how much data each shard holds for a sharded collection. When the difference crosses a migration threshold, it moves ranges from fuller shards to emptier ones. It runs on the primary of the config server replica set and is enabled by default.",
  },
  {
    type: "p",
    text: "A collection is considered balanced while the data difference between shards stays below three times the configured range size. With MongoDB's documented default range size of 128 MB, the threshold is 384 MB. Below that, the balancer leaves the collection alone even if the counts are not identical. This dead band prevents constant small moves.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The balancer sits above the shards and below the config servers. It decides which range should move, sends the migration to the donor, and updates cluster metadata after the recipient catches up. Application traffic continues during the copy: the donor still owns writes for the range until the metadata switch.",
  },
  {
    type: "p",
    text: "Each shard can participate in at most one migration at a time. A cluster with n shards can therefore run at most n/2 migrations concurrently. That bound limits concurrency, not the bandwidth of one large range. A balancing window limits when migrations may run; the window is relative to the local time zone of the config server primary.",
  },
  {
    type: "table",
    headers: ["State", "What it means", "What it does not mean"],
    rows: [
      ["Balancer enabled", "New migrations may start when the threshold is crossed", "A migration is currently running"],
      ["Balancer disabled", "No new migrations start", "The cluster is balanced"],
      ["Imbalance below 3× range size", "The balancer deliberately does nothing", "Every shard has identical data"],
      ["Migration in progress", "A donor and recipient are copying a range", "The cluster has more capacity"],
      ["Window closed", "Migrations wait for the window", "The balancer is broken"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Application p99: the tail while migration I/O shares the shards.",
      "Shared I/O utilization: application traffic plus reads and writes from the copy.",
      "Hottest shard CPU: cluster capacity follows the busiest shard.",
      "Remaining imbalance: how much data still separates the fullest and emptiest shard.",
      "Migration throughput: range size multiplied by the migration rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and confirm the balancer is enabled but idle because the imbalance is below the threshold. Apply Balance during peak: p99 and I/O rise while the copy runs. Stop the balancer to separate the cost of migration from the cost of traffic, then try the recovery preset. Use the experiment before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Balancing is not a capacity plan",
    body: "Moving ranges makes data distribution more even over time. It does not split a hot key inside one range, and it does not add CPU, memory, or IOPS. If one key drives the load, the balancer can move the range that contains it and leave the hot shard hot.",
  },
  { type: "sim", simId: "balancer" },
  { type: "experiment", experimentId: "predict-balance-window" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The balancer compared the data difference with three times the range size. Once the difference crossed the threshold, it started copying ranges. The donor read documents and the recipient wrote them while both continued to serve application traffic. Shared I/O utilization rose, queueing increased, and p99 rose before the remaining imbalance fell. When the difference dropped back inside the dead band, migrations stopped and latency recovered.",
  },
  {
    type: "p",
    text: "The cost and the benefit arrived at different times. The copy cost was immediate; the distribution benefit arrived only as ranges completed. At peak, the copy competed with the workload that was already using the same disks and network. At a lower traffic period, the same migration could finish without breaching the latency budget.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`sh.isBalancerRunning()` reports whether a balancing round is active; it is not the same as whether the balancer is enabled.",
      "`sh.getBalancerState()` and `sh.getBalancerWindow()` show the enablement state and the configured window.",
      "`sh.balancerCollectionStatus()` reports whether a collection is balanced or has ranges to move.",
      "Per-shard CPU and disk latency rise on the donor and recipient during a migration, not uniformly across the cluster.",
      "The config server primary is the node running the balancer; its local time zone defines the window.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether a migration is actually running before you disable or enable anything. Then check the data difference against three times the range size. If the cluster is imbalanced and p99 is already high, separate the cost of moving data from the cost of the current traffic. If chunk counts look even but one shard is hot, inspect the shard key and hot keys before touching the balancer.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the balancer is enabled, inside its window, and actively moving ranges.",
      "Compare the data difference with three times the configured range size.",
      "If latency is the priority, stop or throttle migrations and schedule a window with headroom.",
      "If distribution is the priority, lower the migration rate rather than disabling balancing indefinitely.",
      "If one shard stays hot with even chunk counts, investigate the shard key and hot keys.",
      "After the window, verify the imbalance fell and p99 returned to its baseline.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An immediate rebalance reduces imbalance sooner but adds I/O during the busiest period.",
      "A balancing window protects peak latency but delays convergence and leaves the cluster uneven for longer.",
      "A lower migration rate reduces the burst but extends the time the cluster spends moving data.",
      "Disabling the balancer permanently avoids migration cost but makes the next rebalance larger.",
      "The balancer fixes data distribution, not a hot key or a monotonically increasing shard key.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "balance-during-peak",
    question: "Chunks are imbalanced and the balancer is off. Do you enable it during peak traffic?",
    difficulty: 2,
    hints: [
      "Separate the cost of copying from the benefit of distribution.",
      "Check the data difference against the migration threshold.",
      "A window changes when the work runs, not how much work there is.",
    ],
    answer:
      "I would not enable a high migration rate at peak by default. First I would confirm the imbalance is above three times the configured range size and that a migration is the right fix. Then I would check whether p99 is already near budget and whether the donor and recipient have I/O headroom. If latency is tight, I would schedule a balancing window or lower the rate. If the hot shard is caused by a hot key rather than uneven ranges, the balancer will not fix it.",
    followUps: [
      "How does the range size change the balancing threshold?",
      "What does a balancing window control?",
      "When would you accept the latency cost?",
    ],
    redFlags: [
      "Enables balancing at peak without checking I/O headroom.",
      "Assumes balancing is free because it is a background process.",
      "Uses the balancer to fix a hot key.",
    ],
    rubric: [
      "Names the 3× range-size threshold.",
      "Separates copy cost from distribution benefit.",
      "Considers a window or lower rate.",
      "Distinguishes imbalance from a hot key.",
    ],
  },
  {
    id: "why-idle",
    question: "The cluster has uneven chunk counts but the balancer is not moving anything. Why?",
    difficulty: 2,
    hints: [
      "Uneven counts are not the same as an imbalance above the threshold.",
      "The balancer is disabled, outside its window, or already moving another range.",
      "MongoDB uses a dead band to avoid churn.",
    ],
    answer:
      "The balancer may be enabled but idle because the data difference is still below three times the configured range size. It may also be outside its active window, disabled, or waiting because each shard can participate in only one migration at a time. I would check the balancer state, the window, the collection status, and the actual data difference before calling it broken.",
    followUps: [
      "Why does MongoDB use a dead band instead of equalizing every chunk?",
      "What does `sh.balancerCollectionStatus()` return?",
      "How does a zone affect balancing?",
    ],
    redFlags: [
      "Assumes equal chunk counts are required.",
      "Restarts the config server before checking state.",
      "Ignores the balancing window.",
    ],
    rubric: [
      "Mentions the 3× range-size threshold.",
      "Checks enablement, window, and concurrency.",
      "Uses collection status as evidence.",
      "Explains the dead band.",
    ],
  },
  {
    id: "hot-shard-balanced",
    question: "One shard is hot while chunk counts look even. Is the balancer broken?",
    difficulty: 3,
    hints: [
      "The balancer moves ranges, not individual keys.",
      "A hot key can live inside one range.",
      "Check the shard key before the balancer.",
    ],
    answer:
      "Not necessarily. The balancer equalizes data across ranges, but a single hot key or a monotonically increasing shard key can concentrate traffic inside one range. Moving that range moves the hot key with it, and splitting does not split the key's request rate. I would inspect per-key traffic and the shard key distribution before changing balancer settings. The fix is usually a different shard key or an application-level split of the hot key.",
    followUps: [
      "How would you prove a hot key is the cause?",
      "What does a monotonic shard key do to the balancer?",
      "Can zones make this worse?",
    ],
    redFlags: [
      "Disables and re-enables the balancer repeatedly.",
      "Assumes even chunk counts mean even load.",
      "Moves the range without inspecting the key.",
    ],
    rubric: [
      "Separates range distribution from key distribution.",
      "Names the hot-key or monotonic-key cause.",
      "Checks per-key or per-shard evidence.",
      "Chooses a shard-key or application fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show balancer state, active migrations, per-shard I/O, and p99.",
      "The team knows the configured range size and the resulting 3× balancing threshold.",
      "A balancing window is documented for peak traffic periods.",
      "Alerts distinguish a hot shard from an imbalanced collection.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether a migration is running before changing balancer state.",
      "Check the donor and recipient, not only the cluster average.",
      "Lower the migration rate or close the window if p99 is near budget.",
      "Do not disable the balancer permanently to hide a hot-key problem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the remaining imbalance and whether migrations completed.",
      "Check that p99 returned to baseline after the copy stopped.",
      "Review whether the window covers the traffic pattern that caused the conflict.",
      "Record whether the imbalance was data volume or a hot key.",
    ],
  },
];

const references = [
  {
    title: "Sharded Cluster Balancer",
    url: "https://www.mongodb.com/docs/manual/core/sharding-balancer-administration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Balancer role, migration thresholds, one migration per shard, and balancing windows.",
  },
  {
    title: "Manage Sharded Cluster Balancer",
    url: "https://www.mongodb.com/docs/manual/tutorial/manage-sharded-cluster-balancer/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Enablement, windows, collection status, and operational commands.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    balancer: {
      model: balancerModel,
      presets,
      instructions:
        "Start Healthy, then apply Balance during peak. Watch p99 and shared I/O rise while the remaining imbalance falls. Stop the balancer to separate migration cost from traffic cost, then compare the recovery preset.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Shard capacity, I/O cost, and latency are teaching values. MongoDB documents the 3× range-size balancing threshold, the 128 MB default range size, one migration per shard, and balancing windows.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-chunk-migration", "mongodb-hot-shard", "mongodb-shard-key"],
};
