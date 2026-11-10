import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_WRITE_RATE = 40_000;
const MAX_BACKLOG = 2_000_000_000;
const PRIMARY_CAPACITY = 40_000;

const params: ParamSpec[] = [
  {
    id: "writeRate",
    label: "Primary write rate",
    min: 1_000,
    max: 40_000,
    step: 500,
    value: 8_000,
    unit: " writes/s",
    group: "Workload",
    help: "Write operations per second that produce oplog entries. A write burst increases both the oplog fill rate and the work the secondary must apply.",
    format: "rps",
  },
  {
    id: "applyCapacity",
    label: "Secondary apply capacity",
    min: 1_000,
    max: 40_000,
    step: 500,
    value: 12_000,
    unit: " ops/s",
    group: "Secondary",
    help: "How many oplog operations the secondary can apply per second. If the primary writes faster for long enough, the backlog grows.",
    format: "rps",
  },
  {
    id: "oplogSizeMB",
    label: "Oplog size",
    min: 512,
    max: 51_200,
    step: 512,
    value: 10_240,
    unit: " MB",
    group: "Oplog",
    help: "Configured size of the capped oplog. The window is the time between its oldest and newest entries, so it depends on write volume and entry size, not size alone.",
    format: "count",
  },
  {
    id: "entryBytes",
    label: "Average oplog entry",
    min: 256,
    max: 4_096,
    step: 256,
    value: 1_024,
    unit: " bytes",
    group: "Oplog",
    help: "Average bytes per oplog entry. Multi-document updates, deletes, and in-place updates can produce more entries or larger entries than the data size suggests.",
    format: "bytes",
  },
  {
    id: "secondaryPaused",
    label: "Secondary applying",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scenario",
    help: "0 pauses oplog application, for example during a network partition or maintenance. A paused secondary falls behind even when its hardware is healthy.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface LagState {
  backlog: number;
  resync: boolean;
}

interface Computed {
  writeRate: number;
  applyCapacity: number;
  applyRate: number;
  paused: boolean;
  lag: number;
  oplogWindow: number;
  shortfall: number;
  applyUtil: number;
  backlog: number;
  resync: boolean;
  windowMinutes: number;
  primaryCpu: number;
}

function compute(p: Params, state: LagState): Computed {
  const writeRate = clamp(num(p, "writeRate", 8_000), 1_000, MAX_WRITE_RATE);
  const applyCapacity = clamp(num(p, "applyCapacity", 12_000), 1_000, MAX_WRITE_RATE);
  const paused = num(p, "secondaryPaused", 1) < 0.5;
  const applyRate = paused ? 0 : applyCapacity;
  const oplogBytes = clamp(num(p, "oplogSizeMB", 10_240), 512, 51_200) * 1024 * 1024;
  const entryBytes = clamp(num(p, "entryBytes", 1_024), 256, 4_096);
  const backlog = clamp(state.backlog, 0, MAX_BACKLOG);
  const lag = backlog / writeRate;
  const oplogWindow = oplogBytes / (writeRate * entryBytes);
  const shortfall = state.resync ? Math.max(oplogWindow, lag - oplogWindow) : Math.max(0, lag - oplogWindow);
  const applyUtil = paused ? 0 : clamp((writeRate / applyCapacity) * 100, 0, 200);
  const primaryCpu = clamp((writeRate / PRIMARY_CAPACITY) * 100, 0, 120);

  return {
    writeRate,
    applyCapacity,
    applyRate,
    paused,
    lag,
    oplogWindow,
    shortfall,
    applyUtil,
    backlog,
    resync: state.resync,
    windowMinutes: oplogWindow / 60,
    primaryCpu,
  };
}

function capacityHealth(value: number): Health {
  if (value >= 150) return "crit";
  if (value >= 90) return "warn";
  return "ok";
}

function lagHealth(value: number): Health {
  if (value >= 20) return "crit";
  if (value >= 5) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function formatMinutes(value: number): string {
  if (value < 1) return `${(value * 60).toFixed(0)}s`;
  if (value < 10) return `${value.toFixed(1)}min`;
  return `${value.toFixed(0)}min`;
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const secondaryHealth: Health = values.resync
    ? "down"
    : worst(capacityHealth(values.applyUtil), lagHealth(values.lag));
  const clientHealth: Health = values.resync
    ? "warn"
    : values.lag >= 20
      ? "crit"
      : values.lag >= 5
        ? "warn"
        : "ok";
  const primaryHealth: Health =
    values.primaryCpu >= 90 ? "crit" : values.primaryCpu >= 75 ? "warn" : "ok";

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: clientHealth,
      sublabel:
        values.lag >= 5
          ? `secondary reads up to ${values.lag.toFixed(0)}s stale`
          : `${Math.round(values.writeRate).toLocaleString()} writes/s`,
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: primaryHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.writeRate,
      sublabel: `${values.writeRate.toLocaleString()} writes/s · oplog ${formatMinutes(values.windowMinutes)}`,
      detail:
        "The primary applies writes and records them in a capped oplog. The oplog window is how long a disconnected secondary can stay offline and still catch up from the oplog.",
      meta: { view: "replication", lag: 0 },
    },
    {
      id: "secondary",
      label: "Secondary",
      kind: "db",
      role: "replica",
      health: secondaryHealth,
      utilization: clamp(values.applyUtil / 100),
      throughput: values.applyRate,
      sublabel: values.resync
        ? `fell off oplog · full resync required`
        : values.paused
          ? "apply paused"
          : `lag ${values.lag.toFixed(1)}s · window ${formatMinutes(values.windowMinutes)}`,
      detail: values.resync
        ? "The secondary needs an entry that is older than the oldest entry on its sync source. It cannot resume incrementally and must perform an initial sync, copying the data set and building indexes again."
        : "The secondary copies and applies oplog entries asynchronously. If its apply rate falls below the primary write rate, the backlog and lag grow. If it stays behind longer than the oplog window, it falls off the oplog.",
      meta: { view: "replication", lag: values.lag, resync: values.resync ? 1 : 0 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-primary", "client", "primary", values.writeRate / MAX_WRITE_RATE, primaryHealth),
      edge("primary-secondary", "primary", "secondary", values.writeRate / MAX_WRITE_RATE, secondaryHealth),
    ],
    metrics: [
      metric("replication-lag", "Replication lag", values.lag, "s", 5, 20, "number"),
      metric("oplog-shortfall", "Oplog shortfall", values.shortfall, "s", 0.5, 1, "number"),
      metric("oplog-window", "Oplog window", values.windowMinutes, "min", undefined, undefined, "number"),
      metric("apply-utilization", "Apply demand vs capacity", values.applyUtil, "%", 90, 150, "percent"),
      metric("backlog", "Apply backlog", Math.round(values.backlog), "ops", undefined, undefined, "count"),
      metric("oplog-write-rate", "Oplog write rate", values.writeRate, "ops/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      backlogOps: Math.round(values.backlog),
      resync: values.resync ? 1 : 0,
      secondaryPaused: values.paused ? 1 : 0,
    },
    summary: values.resync
      ? `Oplog window exceeded · lag ${values.lag.toFixed(0)}s · full resync required`
      : `Lag ${values.lag.toFixed(1)}s · window ${formatMinutes(values.windowMinutes)} · apply ${values.applyUtil.toFixed(0)}% of capacity`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 12)) / 2.8);
  const rows: [string, number, number][] = [
    ["replication-lag", values.lag, 0.02],
    ["oplog-shortfall", values.shortfall, 0.01],
    ["oplog-window", values.windowMinutes, 0.01],
    ["apply-utilization", values.applyUtil, 0.2],
    ["backlog", values.backlog, 0],
    ["oplog-write-rate", values.writeRate, 10],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 5,
    crit: 20,
    title: "The secondary is falling behind",
    cause: "The primary is producing oplog entries faster than the secondary can apply them, or the secondary cannot apply at all. The backlog becomes lag, and lag is the freshness budget for secondary reads and the recovery window for failover.",
    fix: "Reduce the write burst, increase secondary apply capacity, or remove the network or disk bottleneck. Check the oplog window before it runs out; if the secondary is already too far behind, only a resync can restore it.",
    checkFirst: [
      "Check `rs.printSecondaryReplicationInfo()` for lag on the specific member.",
      "Check secondary CPU, disk throughput, and network latency.",
      "Check the primary write rate and whether flow control is active.",
    ],
  },
  {
    id: "oplog-shortfall",
    metricId: "oplog-shortfall",
    warn: 0.5,
    crit: 1,
    title: "The secondary has fallen off the oplog",
    cause: "The secondary needs an oplog entry that is older than the oldest entry retained on its sync source. The oplog is capped, so the missing history cannot be replayed. Incremental catch-up is no longer possible.",
    fix: "Perform a full initial sync for the member. A larger oplog reduces the chance of recurrence, but it does not repair the current gap. Check whether the member is also missing indexes or has a disk problem before resyncing.",
    checkFirst: [
      "Check `rs.printReplicationInfo()` for the oplog window and oldest entry.",
      "Check `rs.status()` for the member state and sync source.",
      "Check whether the member was paused, partitioned, or slower than the write burst.",
    ],
  },
  {
    id: "apply-utilization",
    metricId: "apply-utilization",
    warn: 90,
    crit: 150,
    title: "The secondary cannot apply the write stream fast enough",
    cause: "Apply demand is at or above the modeled apply capacity. The backlog grows even if the secondary is healthy; a sustained overload eventually exceeds the oplog window.",
    fix: "Increase secondary CPU, disk, or I/O headroom, or reduce the primary write burst. Watch disk throughput and slow oplog application messages, not only CPU.",
    checkFirst: [
      "Check disk I/O and the `applied op` slow-log messages on the secondary.",
      "Check whether the secondary is serving reads that compete with apply work.",
      "Check the primary write rate and operation mix.",
    ],
  },
];

export const replicationLagModel: SimModel = {
  id: "mongodb-replication-lag",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, { backlog: 0, resync: false });
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const writeRate = clamp(num(p, "writeRate", 8_000), 1_000, MAX_WRITE_RATE);
    const applyCapacity = clamp(num(p, "applyCapacity", 12_000), 1_000, MAX_WRITE_RATE);
    const paused = num(p, "secondaryPaused", 1) < 0.5;
    const previousResync = Number(frame.flags.resync ?? 0) === 1;
    let backlog = Math.max(0, Number(frame.flags.backlogOps ?? 0));
    let resync = previousResync;

    if (!resync) {
      const applyRate = paused ? 0 : applyCapacity;
      backlog += (writeRate - applyRate) * Math.max(0, dt);
      backlog = clamp(backlog, 0, MAX_BACKLOG);
    }
    const valuesForWindow = compute(p, { backlog, resync });
    if (!resync && valuesForWindow.lag >= valuesForWindow.oplogWindow) {
      resync = true;
    }
    const values = compute(p, { backlog, resync });
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.2, 0.2) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "replication-lag" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.resync && !Number(next.flags.resyncAnnounced ?? 0)) {
      pushEvent(next, {
        id: "oplog-window-exceeded",
        at: frame.t,
        severity: "crit",
        title: "Secondary fell off the oplog",
        detail:
          "The required oplog entry is older than the oldest retained entry. The member cannot catch up incrementally and needs a full initial sync.",
        nodeId: "secondary",
      });
      next.flags.resyncAnnounced = 1;
    }
    if (values.paused && !Number(next.flags.pauseAnnounced ?? 0)) {
      pushEvent(next, {
        id: "secondary-paused",
        at: frame.t,
        severity: "warn",
        title: "Secondary stopped applying the oplog",
        detail: "A paused or partitioned secondary falls behind even when its CPU and disk look healthy.",
        nodeId: "secondary",
      });
      next.flags.pauseAnnounced = 1;
    }
    if (!values.paused) next.flags.pauseAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const backlog = Math.max(0, Number(frame.flags.backlogOps ?? 0));
    const resync = Number(frame.flags.resync ?? 0) === 1;
    const values = compute(p, { backlog, resync });
    const items: string[] = [
      `The oplog window is about ${formatMinutes(values.windowMinutes)} at ${Math.round(values.writeRate).toLocaleString()} writes/s and an illustrative ${Math.round(num(p, "entryBytes", 1024))}-byte average entry.`,
    ];
    if (values.resync) {
      items.push(
        "The secondary needs history that the capped oplog no longer retains. It must run an initial sync; reducing the write rate now will not make the missing entries reappear.",
      );
    } else if (values.lag > 0) {
      items.push(
        `Lag is ${values.lag.toFixed(1)}s with ${Math.round(values.backlog).toLocaleString()} operations queued. A backlog grows whenever the primary writes faster than the secondary applies.`,
      );
    } else {
      items.push("No backlog is modeled. The secondary is keeping up with the current write rate.");
    }
    items.push(
      values.applyUtil >= 100
        ? `Apply demand is ${values.applyUtil.toFixed(0)}% of capacity, so the backlog cannot drain while this write rate continues.`
        : `Apply demand is ${values.applyUtil.toFixed(0)}% of capacity; the secondary has headroom to drain a backlog.`,
    );
    if (values.paused && !values.resync) {
      items.push("Oplog application is paused. Time spent disconnected still consumes the oplog window.");
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
    description: "8k writes/s, 12k apply capacity, and a 10 GB oplog. The secondary keeps up.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "24k writes/s against 22k apply capacity. Lag grows slowly and the oplog window is short.",
    tone: "warn",
    params: defaults({ writeRate: 24_000, applyCapacity: 22_000, oplogSizeMB: 10_240, entryBytes: 1_024 }),
  },
  {
    id: "failure",
    label: "Write burst",
    description: "32k writes/s, 8k apply capacity, and a 2 GB oplog with large entries. The member falls off.",
    tone: "crit",
    params: defaults({ writeRate: 32_000, applyCapacity: 8_000, oplogSizeMB: 2_048, entryBytes: 2_048 }),
  },
  {
    id: "large-oplog",
    label: "Larger oplog",
    description: "The same write burst with a 20 GB oplog. Lag is critical, but the member stays on the oplog.",
    tone: "crit",
    params: defaults({ writeRate: 32_000, applyCapacity: 8_000, oplogSizeMB: 20_480, entryBytes: 2_048 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Writes ease and apply capacity has headroom. The secondary catches up.",
    tone: "ok",
    params: defaults({ writeRate: 6_000, applyCapacity: 14_000, oplogSizeMB: 20_480, entryBytes: 1_024 }),
  },
];

const experiment: Experiment = {
  id: "predict-resync",
  title: "Predict what happens when the secondary falls off the oplog",
  simId: "replication-lag",
  question:
    "A secondary falls more than one oplog window behind during a write burst. What happens when the burst ends?",
  prediction: {
    options: [
      { id: "catch", label: "It catches up from the oplog once apply capacity is free" },
      { id: "resync", label: "It must perform a full initial sync because the missing entries are gone" },
      { id: "primary", label: "It becomes primary immediately because it has the oldest data" },
      { id: "reads", label: "Only secondary reads are affected; replication resumes without intervention" },
    ],
    correctOptionId: "resync",
    explanation:
      "The oplog is capped. Once the secondary needs an entry older than the oldest retained entry on its sync source, it cannot replay the missing history. Reducing the write rate frees apply capacity, but it does not bring the deleted oplog entries back. The member needs an initial sync to rebuild its copy.",
  },
  setup: defaults({ writeRate: 32_000, applyCapacity: 8_000, oplogSizeMB: 2_048, entryBytes: 2_048, secondaryPaused: 1 }),
  runFor: 60,
  observe: [
    "Lag rises through the warning and critical thresholds while the secondary is healthy enough to apply.",
    "The oplog window is only tens of seconds at this write rate and entry size.",
    "Once lag passes the window, the shortfall metric becomes positive and the member needs a resync.",
    "The backlog does not drain by itself because apply demand exceeds capacity.",
  ],
  explain:
    "A larger oplog buys time, but it does not increase apply throughput. A smaller write rate lets the secondary drain the backlog only if the missing entries are still in the oplog. Once the window is crossed, the correct recovery is a full resync, followed by fixing the capacity or write-burst cause.",
  fix: defaults({ writeRate: 8_000, applyCapacity: 14_000, oplogSizeMB: 20_480, entryBytes: 1_024, secondaryPaused: 1 }),
  debrief:
    "Size the oplog for the longest secondary outage you must survive, not for the average write rate. Then monitor lag and the oplog window together. If a secondary falls off, resync it and remove the cause: apply capacity, disk throughput, network, or an unbounded write burst. Enlarging the oplog after the fact prevents the next gap but does not repair this one.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The MongoDB oplog is a capped collection in the `local` database that records operations which modify data. Every replica-set member keeps a copy. Secondaries copy entries from a sync source and apply them asynchronously. Replication lag is the delay between an operation on the primary and its application on a secondary.",
  },
  {
    type: "p",
    text: "The oplog window is the time between the oldest and newest entry in the oplog. It is not the same as the configured size: a high write rate with large entries fills the same number of megabytes faster. If a secondary is disconnected longer than the window, the entries it needs are gone. It cannot catch up incrementally and must perform a full initial sync.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "diagram",
    id: "replica-lag",
    caption: "The primary writes to the capped oplog; a secondary applies entries asynchronously and falls behind when its apply rate is lower.",
  },
  {
    type: "p",
    text: "The oplog is the handoff between the write path and the replication path. A write burst increases the fill rate. A slow secondary, a paused apply process, a network partition, or disk contention lowers the drain rate. Lag is the backlog divided by the primary write rate in this model, and the window is the oplog size divided by the byte rate of new entries.",
  },
  {
    type: "table",
    headers: ["Question", "Signal", "What it answers"],
    rows: [
      ["How far behind?", "`rs.printSecondaryReplicationInfo()`", "Lag per secondary and the last synced time"],
      ["How much time is left?", "`rs.printReplicationInfo()`", "Oplog size and the start-to-end time range"],
      ["Can it catch up?", "Lag versus oplog window", "Whether the needed entries still exist"],
      ["Why is it behind?", "Secondary CPU, disk, network, slow apply logs", "Apply capacity or delivery bottleneck"],
    ],
  },
  {
    type: "p",
    text: "Flow control can slow the primary when majority-committed lag approaches `flowControlTargetLagSeconds`, but it does not repair an unresponsive secondary. A larger oplog extends the window and reduces resync risk, but it does not increase apply throughput. Those are separate levers.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replication lag: how far the secondary is behind the primary.",
      "Oplog shortfall: how much older than the retained oplog the secondary needs to read.",
      "Oplog window: the time range currently retained.",
      "Apply demand versus capacity: whether the backlog can drain at the current write rate.",
      "Apply backlog: the queued operations that still need to be applied.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Write burst. Watch lag and the oplog window converge. Apply Larger oplog to see the member stay on the oplog with the same lag. Use the experiment to predict whether a lagging member can catch up after the burst.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Lag is not just a read freshness problem",
    body: "A lagging secondary is also a weaker failover candidate. If it has fallen off the oplog, it cannot become an up-to-date primary without a resync. Treat the oplog window as a recovery budget, not only as a dashboard number.",
  },
  { type: "sim", simId: "replication-lag" },
  { type: "experiment", experimentId: "predict-resync" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write burst filled the oplog faster than the secondary could apply it. The backlog became lag, and the lag crossed the warning and critical thresholds while the secondary was still applying entries. When lag passed the oplog window, the entry the secondary needed had already been removed from the capped collection. Incremental catch-up was no longer possible.",
  },
  {
    type: "p",
    text: "A larger oplog kept the same burst on the oplog for longer, so the member stayed eligible to catch up. It did not reduce the lag or increase apply throughput. The recovery path was to relieve apply pressure and resync the member if it had already fallen off.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`rs.printSecondaryReplicationInfo()` shows increasing lag on one member.",
      "`rs.printReplicationInfo()` shows a short oplog window for the write volume.",
      "`rs.status()` shows the member in RECOVERING or STARTUP2 during resync.",
      "Secondary logs contain `applied op` messages above the slow operation threshold.",
      "Disk and network metrics show whether apply or delivery is the bottleneck.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the secondary's lag and the primary's oplog window together. If lag is still inside the window, fix apply capacity or reduce the write burst. If lag is outside the window, stop trying to catch up incrementally and resync the member.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure lag and the oplog window before changing anything.",
      "Find the bottleneck: apply CPU, disk throughput, network, or the primary write rate.",
      "If the member is inside the window, reduce the write burst or add apply capacity and let the backlog drain.",
      "If the member is outside the window, resync it with an initial sync.",
      "Enlarge the oplog for the outage window you need to survive, using `replSetResizeOplog`.",
      "Verify the member catches up and stays caught up at peak traffic.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger oplog increases tolerance for secondary downtime but consumes disk and can lengthen recovery checks.",
      "Slowing the primary with flow control protects lag but can reduce write throughput.",
      "Adding apply capacity is faster than resyncing a member, but it does not repair an existing oplog gap.",
      "A full resync restores a usable member but adds load to the sync source and takes time.",
      "Serving reads from a lagging secondary lowers primary load but exposes stale data.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "window-math",
    question: "How does write rate change the oplog window if the oplog size stays the same?",
    difficulty: 2,
    hints: [
      "The oplog is capped by bytes.",
      "Entries arrive per write.",
      "Window is a time range, not a size.",
    ],
    answer:
      "The window is the time between the oldest and newest entry, so it shrinks as the byte rate into the oplog rises. If the write rate doubles and the average entry size stays the same, the same number of megabytes represents roughly half the time. Larger entries, such as from multi-document updates, can shorten it further. The configured size is only half of the calculation.",
    followUps: [
      "How would you estimate the window before a migration?",
      "What does `rs.printReplicationInfo()` show?",
      "Why can a larger oplog still not be enough?",
    ],
    redFlags: [
      "Equates oplog size with window in hours.",
      "Ignores entry size.",
      "Assumes the default is always sufficient.",
    ],
    rubric: [
      "Defines the window as a time range.",
      "Relates byte rate and size.",
      "Mentions entry size.",
      "Names the monitoring command.",
    ],
  },
  {
    id: "resync",
    question: "A secondary is 90 seconds behind and the oplog window is 60 seconds. Can it catch up from the oplog?",
    difficulty: 3,
    hints: [
      "The needed entry must still exist.",
      "The oplog is capped.",
      "What does the member need instead?",
    ],
    answer:
      "No. The secondary needs an entry that is older than the oldest retained entry, so the history it needs has been removed. Reducing the write rate or adding apply capacity frees the secondary to apply, but it cannot replay entries that no longer exist. The member needs a full initial sync. After that, size the oplog for the outage window and fix the apply bottleneck so it does not happen again.",
    followUps: [
      "What does `rs.status()` show during the resync?",
      "How would you avoid this during a planned maintenance window?",
      "What load does the resync add to the source?",
    ],
    redFlags: [
      "Says it will catch up once the burst ends.",
      "Ignores the capped collection behavior.",
      "Restarts the secondary without a resync plan.",
    ],
    rubric: [
      "States that the entry is gone.",
      "Requires initial sync.",
      "Separates window from apply capacity.",
      "Names prevention.",
    ],
  },
  {
    id: "cause",
    question: "Lag is growing but the secondary CPU is only 30%. What else could cause it?",
    difficulty: 3,
    hints: [
      "Replication needs network and disk too.",
      "The apply process can be paused.",
      "Look at the slow apply log.",
    ],
    answer:
      "Low CPU does not rule out a replication bottleneck. The secondary could be waiting on disk I/O, network delivery from the sync source, a paused apply process, a long-running operation, or lock contention. I would check disk throughput and latency, network between members, `rs.status()` and the sync source, and slow `applied op` messages. I would also check whether the member is serving reads that compete with apply work.",
    followUps: [
      "Why can a disk bottleneck look like low CPU?",
      "What does chained replication change?",
      "How does flow control show up?",
    ],
    redFlags: [
      "Assumes CPU is the only apply resource.",
      "Restarts the member immediately.",
      "Ignores network and disk.",
    ],
    rubric: [
      "Names disk, network, and apply pauses.",
      "Uses slow apply logs.",
      "Checks the sync source.",
      "Avoids a premature restart.",
    ],
  },
  {
    id: "size-oplog",
    question: "How would you size an oplog for a secondary that may be offline for a maintenance window?",
    difficulty: 3,
    hints: [
      "Start from the longest expected outage.",
      "Estimate bytes per second, not writes per second alone.",
      "Leave room for bursts.",
    ],
    answer:
      "I would estimate the peak byte rate into the oplog: write rate times average entry size, with a margin for multi-document updates and bursts. Multiply by the longest outage I need to survive, then add headroom. I would verify the result with `rs.printReplicationInfo()` under realistic load, and use `replSetResizeOplog` to change it. A larger oplog is insurance for outages; it does not fix a secondary that cannot apply fast enough.",
    followUps: [
      "What is the default oplog sizing rule?",
      "Why resize all members?",
      "How does `oplogMinRetentionHours` change the calculation?",
    ],
    redFlags: [
      "Sizes by write count alone.",
      "Ignores peak and entry size.",
      "Thinks a larger oplog increases apply throughput.",
    ],
    rubric: [
      "Uses byte rate and outage duration.",
      "Adds burst headroom.",
      "Verifies with monitoring.",
      "Separates sizing from apply capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The oplog window is monitored at peak write rate, not only at average.",
      "The longest acceptable secondary outage is written down and covered by the window.",
      "Secondary disk, CPU, and network headroom are sufficient for peak apply demand.",
      "Alerts cover lag, oplog window, and slow oplog application.",
      "The team knows how to resize the oplog and perform an initial sync.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check lag and the oplog window together.",
      "Find whether the secondary is applying or paused.",
      "Check disk, network, and slow apply messages.",
      "Do not promise a quick catch-up after the window is crossed.",
      "Record the write burst or maintenance event that started the lag.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Resync the member if it fell off the oplog.",
      "Fix the apply bottleneck or the unbounded write burst.",
      "Resize the oplog if the outage budget is not covered.",
      "Verify lag and window at peak after the member rejoins.",
    ],
  },
];

const references = [
  {
    title: "Replica Set Oplog",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-oplog/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Capped oplog, default sizing, oplog window, and the definition of replication lag.",
  },
  {
    title: "Troubleshoot Replica Sets",
    url: "https://www.mongodb.com/docs/manual/tutorial/troubleshoot-replica-sets/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Checking lag, oplog size, slow oplog application, flow control, and the recommendation for an outage-sized window.",
  },
  {
    title: "Change the Oplog Size of Self-Managed Replica Set Members",
    url: "https://www.mongodb.com/docs/manual/tutorial/change-oplog-size/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Using `replSetResizeOplog` to change the oplog without restarting `mongod`.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "replication-lag": {
      model: replicationLagModel,
      presets,
      instructions:
        "Start Healthy, then apply Write burst. Watch lag and the oplog window converge. Apply Larger oplog to compare resync risk. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Write rates, apply capacity, entry sizes, and windows are teaching values; MongoDB's oplog sizing and resync behavior follow the documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-replica-set", "mongodb-read-preference", "mongodb-elections"],
};
