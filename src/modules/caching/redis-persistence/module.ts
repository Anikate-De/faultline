import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MODES = ["no persistence", "RDB snapshots", "AOF everysec", "AOF always"];
const WRITE_CAPACITY = 60_000;

const params = [
  {
    id: "writeRps",
    label: "Write rate",
    min: 500,
    max: 60_000,
    step: 500,
    value: 5_000,
    unit: " rps",
    group: "Write path",
    help: "Acknowledged writes per second. This is the work at risk during a crash.",
    format: "rps" as const,
  },
  {
    id: "persistence",
    label: "Persistence mode",
    min: 0,
    max: 3,
    step: 1,
    value: 2,
    unit: "",
    group: "Durability",
    help: "0 none, 1 RDB snapshots, 2 AOF everysec, 3 AOF always. AOF everysec is the usual starting point when AOF is enabled.",
    format: "count" as const,
  },
  {
    id: "snapshotSeconds",
    label: "RDB snapshot interval",
    min: 40,
    max: 900,
    step: 20,
    value: 300,
    unit: "s",
    group: "Durability",
    help: "Worst-case loss with RDB is the time since the last completed snapshot. AOF everysec ignores this setting.",
    format: "number" as const,
  },
  {
    id: "datasetGb",
    label: "Dataset size",
    min: 1,
    max: 64,
    step: 1,
    value: 8,
    unit: " GB",
    group: "Recovery",
    help: "Data that must be loaded before the instance serves traffic. Larger datasets lengthen restart time.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function modeOf(p: Params): number {
  return Math.round(clamp(num(p, "persistence", 2), 0, 3));
}

interface Values {
  mode: number;
  modeName: string;
  writeRps: number;
  snapshotSeconds: number;
  datasetGb: number;
  lossWindow: number;
  lostWrites: number;
  writeP99: number;
  recoverySeconds: number;
}

function compute(p: Params): Values {
  const mode = modeOf(p);
  const writeRps = Math.max(1, num(p, "writeRps", 5_000));
  const snapshotSeconds = Math.max(1, num(p, "snapshotSeconds", 300));
  const datasetGb = Math.max(0.1, num(p, "datasetGb", 8));
  const lossWindow = mode === 0 ? 86_400 : mode === 1 ? snapshotSeconds : mode === 2 ? 1 : 0;
  const writeP99 = mode === 0 ? 1.1 : mode === 1 ? 1.8 : mode === 2 ? 2.2 : 4.8;
  const loadRate = mode === 2 || mode === 3 ? 220 : 350;
  const recoverySeconds = mode === 0 ? 5 : (datasetGb * 1024) / loadRate;
  return {
    mode,
    modeName: MODES[mode],
    writeRps,
    snapshotSeconds,
    datasetGb,
    lossWindow,
    lostWrites: writeRps * lossWindow,
    writeP99,
    recoverySeconds,
  };
}

function health(lost: number, p99: number, recovery: number): "ok" | "warn" | "crit" {
  if (lost >= 1_000_000 || p99 >= 20 || recovery >= 300) return "crit";
  if (lost >= 10_000 || p99 >= 5 || recovery >= 120) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return Math.round(value).toLocaleString();
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 5)) / 2.5);
  frame.series["lost-writes"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.lostWrites * wave(index)));
  frame.series["loss-window"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.lossWindow * wave(index + 2)));
  frame.series["write-p99"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.writeP99 * wave(index + 3) + Math.sin(index / 2.1) * 0.05),
  );
  frame.series["recovery-time"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.recoverySeconds * wave(index + 4)));
  frame.series["dataset"] = Array.from({ length: 24 }, () => v.datasetGb);
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const nodeHealth = health(v.lostWrites, v.writeP99, v.recoverySeconds);
  const diskHealth = v.writeP99 >= 20 ? "crit" : v.writeP99 >= 5 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Writers",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(v.writeRps).toLocaleString()} writes/s`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis primary",
        kind: "cache",
        role: "primary",
        health: nodeHealth,
        utilization: clamp(v.writeRps / WRITE_CAPACITY),
        throughput: v.writeRps,
        sublabel: `${v.modeName} · p99 ${v.writeP99.toFixed(1)} ms`,
        detail: `Illustrative loss window: ${v.lossWindow >= 3600 ? "one day of writes, assuming a daily external backup" : `${v.lossWindow.toFixed(0)}s`}. Potential acknowledged writes lost on a crash: ${formatCount(v.lostWrites)}.`,
        meta: { view: "flow" },
      },
      {
        id: "disk",
        label: "Persistence target",
        kind: "storage",
        health: diskHealth,
        utilization: v.mode === 3 ? 0.85 : v.mode === 2 ? 0.35 : v.mode === 1 ? 0.45 : 0.1,
        sublabel: v.mode === 3 ? "fsync every write" : v.mode === 2 ? "fsync every second" : v.mode === 1 ? "fork + snapshot" : "no durable copy",
        meta: { view: "flow" },
      },
      {
        id: "recovery",
        label: "Restart target",
        kind: "worker",
        health: v.recoverySeconds >= 300 ? "crit" : v.recoverySeconds >= 120 ? "warn" : "ok",
        utilization: clamp(v.datasetGb / 64),
        sublabel: `load ${v.recoverySeconds.toFixed(0)}s · ${v.datasetGb.toFixed(0)} GB`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-redis", "client", "redis", v.writeRps / WRITE_CAPACITY),
      edge("redis-disk", "redis", "disk", v.mode === 0 ? 0.05 : 0.7, diskHealth),
      edge("disk-recovery", "disk", "recovery", v.mode === 0 ? 0.05 : clamp(v.datasetGb / 64), nodeHealth),
    ],
    metrics: [
      metric("lost-writes", "Potential lost writes", v.lostWrites, "", 10_000, 1_000_000, "count"),
      metric("loss-window", "Loss window", v.lossWindow, "s", 10, 120, "number"),
      metric("write-p99", "Write p99", v.writeP99, "ms", 5, 20, "ms"),
      metric("recovery-time", "Restart load time", v.recoverySeconds, "s", 120, 300, "number"),
      metric("dataset", "Dataset", v.datasetGb, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.modeName}: up to ${formatCount(v.lostWrites)} acknowledged writes at risk, ${v.writeP99.toFixed(1)} ms write p99, ${v.recoverySeconds.toFixed(0)}s to load ${v.datasetGb.toFixed(0)} GB.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lost-writes",
    metricId: "lost-writes",
    warn: 10_000,
    crit: 1_000_000,
    title: "The crash loss window contains acknowledged writes",
    cause:
      "The write was acknowledged before it reached durable storage. RDB only persists at snapshot points; AOF everysec can lose the last second; no persistence loses everything since the last external copy.",
    fix:
      "Choose the loss window the data can tolerate. AOF everysec bounds loss to about one second; AOF always removes the window at a write-latency cost. If the data is reconstructible cache, document that no persistence is intentional.",
    checkFirst: [
      "Compare the gap between the last snapshot or fsync and the crash time.",
      "Check `INFO persistence` for `rdb_last_bgsave_status` and `aof_last_write_status`.",
      "Ask whether the lost records can be rebuilt from the source of truth.",
    ],
  },
  {
    id: "loss-window",
    metricId: "loss-window",
    warn: 10,
    crit: 120,
    title: "The durability window is longer than the data allows",
    cause:
      "Snapshot interval, not write rate, sets the RDB window. A long interval lowers fork and disk cost but widens the period in which acknowledged writes exist only in memory.",
    fix:
      "Shorten the snapshot interval, add AOF, or move the data to a store with the required durability. A snapshot interval is a recovery-point decision, not a tuning detail.",
    checkFirst: [
      "Read the configured `save` points or `appendfsync` policy.",
      "Check when the last successful snapshot completed.",
      "Check whether a failed background save silently left the old snapshot in place.",
    ],
  },
  {
    id: "write-p99",
    metricId: "write-p99",
    warn: 5,
    crit: 20,
    title: "Durability work is slowing the write path",
    cause:
      "AOF always waits for fsync on every write. Fork and copy-on-write during an RDB snapshot can also pause the parent on a large dataset.",
    fix:
      "Match the fsync policy to the durability requirement and keep disk latency low. If AOF always is required, budget the write latency and alert on fsync time; do not hide it behind a retry.",
    checkFirst: [
      "Separate Redis command time from disk fsync time.",
      "Check `INFO persistence` for rewrite or background-save progress.",
      "Check disk latency and queue depth on the volume.",
    ],
  },
  {
    id: "recovery-time",
    metricId: "recovery-time",
    warn: 120,
    crit: 300,
    title: "Restart time exceeds the recovery objective",
    cause:
      "A large RDB or AOF must be read and replayed before the instance serves traffic. AOF replay can be slower than loading a compact RDB.",
    fix:
      "Size the dataset against the recovery objective, keep RDB snapshots for fast restarts, and test the actual load path. A replica with a warm dataset changes the recovery plan.",
    checkFirst: [
      "Measure load time with the real dataset, not an empty instance.",
      "Check whether the instance loads RDB or AOF and how large the files are.",
      "Check whether a replica can be promoted before the primary finishes loading.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const redisPersistenceModel: SimModel = {
  id: "caching-redis-persistence",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const jittered: Params = {
      ...p,
      writeRps: num(p, "writeRps", 5_000) * (1 + rng.between(-0.004, 0.004) * Math.min(1, dt / 0.1)),
    };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (!reset) {
      next.series = Object.fromEntries(Object.entries(frame.series).map(([k, values]) => [k, [...values]]));
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events];
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `${v.modeName} puts up to ${formatCount(v.lostWrites)} acknowledged writes at risk in this model. The write rate multiplies the window; the window comes from the mode.`,
      v.mode === 1
        ? `RDB loses everything since the last completed snapshot. A ${v.snapshotSeconds.toFixed(0)}s interval is a worst case, not a fixed 40s.`
        : v.mode === 2
          ? "AOF everysec fsyncs in the background. Redis documents that up to one second of writes can be lost, so the window is small but not zero."
          : v.mode === 3
            ? "AOF always fsyncs before acknowledging, so the model shows no loss window. The cost is write latency and disk throughput."
            : "No persistence means a restart begins empty. This model assumes a daily external backup, so the loss window is one day of writes; without that backup, the whole dataset is at risk. That is acceptable only when the data is reconstructible and the refill path is planned.",
      `Restart loads ${v.datasetGb.toFixed(0)} GB in about ${v.recoverySeconds.toFixed(0)}s. Durability and recovery time are separate choices; a mode can be durable and still slow to start.`,
      `Use AOF to bound loss and RDB to speed restarts if you need both. Redis can run them together, and it loads the most complete representation at startup.`,
    ];
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
    description: "AOF everysec with a small dataset; at most one second of writes is at risk.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak writes",
    description: "Higher write rate with AOF everysec; the loss window stays small, the count grows.",
    tone: "warn",
    params: defaults({ writeRps: 30_000, persistence: 2, datasetGb: 8 }),
  },
  {
    id: "failure",
    label: "RDB only",
    description: "A 300-second snapshot interval leaves nine million writes at risk at 30k writes/s.",
    tone: "crit",
    params: defaults({ writeRps: 30_000, persistence: 1, snapshotSeconds: 300, datasetGb: 16 }),
  },
  {
    id: "aof-always",
    label: "AOF always",
    description: "Remove the loss window; every acknowledged write waits for fsync.",
    tone: "ok",
    params: defaults({ writeRps: 30_000, persistence: 3, datasetGb: 16 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "AOF everysec at a write rate whose one-second window fits the loss budget.",
    tone: "ok",
    params: defaults({ writeRps: 8_000, persistence: 2, datasetGb: 16 }),
  },
];

const experiment: Experiment = {
  id: "predict-rdb-loss",
  title: "Predict the persistence mode",
  simId: "redis-persistence",
  question:
    "Redis restarts and about 40 seconds of acknowledged writes are gone. Which persistence setting best explains that window?",
  prediction: {
    options: [
      { id: "rdb", label: "RDB snapshots with the last completed snapshot 40 seconds before the crash." },
      { id: "everysec", label: "AOF everysec, which always loses exactly 40 seconds." },
      { id: "always", label: "AOF always, because fsync failed on every write." },
      { id: "none", label: "No persistence, because the whole dataset was lost." },
    ],
    correctOptionId: "rdb",
    explanation:
      "RDB persists at snapshot points. If the last completed snapshot was 40 seconds before the crash, every write after it existed only in memory. AOF everysec is documented to risk up to about one second of writes, and AOF always fsyncs before acknowledging. A missing or failed background save can also widen the RDB gap, which is why the last successful snapshot time matters.",
  },
  setup: defaults({ writeRps: 40_000, persistence: 1, snapshotSeconds: 40, datasetGb: 8 }),
  runFor: 12,
  observe: [
    "The loss window equals the snapshot interval, and the lost-write count is write rate times that window.",
    "Switching to AOF everysec collapses the window to one second without changing the dataset.",
    "Write p99 rises slightly with AOF everysec and more with AOF always.",
    "Restart load time is set by dataset size and persistence format, not by the loss window.",
  ],
  explain:
    "RDB is a point-in-time copy. The recovery point is the last snapshot, not the crash, so the interval is the loss window. AOF logs every write and fsyncs on its configured schedule; everysec reduces the window to roughly a second, while always removes it before the acknowledgment. The tradeoff moves to write latency and disk throughput.",
  fix: defaults({ writeRps: 40_000, persistence: 3, snapshotSeconds: 40, datasetGb: 8 }),
  debrief:
    "AOF always removed the loss window for these writes, at the cost of an fsync on every acknowledged write. AOF everysec would keep the window near one second, which may be enough for cache-like data. The decision is the product's recovery point, not the default configuration.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Persistence is what survives a Redis process restart. RDB (Redis Database) writes a point-in-time snapshot of the dataset to disk. AOF (Append Only File) appends every write command to a log and replays it at startup. With no persistence, a restart begins with an empty dataset. All three choices have a loss window: the period of acknowledged writes that is not yet durable. RDB's window is the time since the last completed snapshot. AOF's window is set by `appendfsync`: `everysec` can lose about one second, `always` fsyncs (flushes) before acknowledging, and `no` leaves flushing to the operating system.",
  },
  {
    type: "p",
    text: "Durability is not the same as recovery time. A large RDB can load quickly and still be hours old. An AOF can lose almost nothing and take a long time to replay. A cache may need neither mode, but that is a decision about the data's reconstructability, not an excuse to leave the default unexamined.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is client, Redis, and the persistence target. Redis acknowledges the write after the command executes; whether it is durable depends on the mode and fsync policy. The restart path is the reverse: load the RDB or replay the AOF before serving traffic. The dataset size, the file format, and the disk determine how long that takes.",
  },
  {
    type: "compare",
    leftTitle: "RDB snapshots",
    rightTitle: "AOF",
    rows: [
      { label: "What is stored", left: "Point-in-time copy of the dataset", right: "Every write command, replayed at startup" },
      { label: "Typical loss window", left: "Since the last completed snapshot; minutes by default", right: "About one second with everysec; none with always" },
      { label: "Write cost", left: "Fork and copy-on-write during a snapshot", right: "Append and fsync; always is the most expensive" },
      { label: "Recovery", left: "Compact file, usually faster to load", right: "Replay log, usually larger and slower" },
      { label: "Best fit", left: "Backups and fast restarts where minutes of loss are acceptable", right: "Data that cannot lose the last second of writes" },
    ],
  },
  {
    type: "p",
    text: "This module uses 1–64 GB datasets, a 40–900 second snapshot interval, and illustrative load rates. The write-loss arithmetic is exact for the model, but the numbers are teaching values, not Redis defaults or guarantees. The no-persistence mode assumes a daily external backup; without one, a restart loses the whole dataset, not one day of writes. Redis documents the everysec window as about one second and recommends using both RDB and AOF when data safety matters.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Potential lost writes: write rate multiplied by the mode's loss window.",
      "Loss window in seconds, with RDB's interval and AOF's fsync policy visible.",
      "Write p99, which rises when every write waits for fsync.",
      "Restart load time, which grows with dataset size and the chosen format.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply RDB only. Watch the loss window jump to the snapshot interval and the lost-write count grow with write rate. Switch to AOF everysec and AOF always to see the window collapse and the write cost rise. Run the experiment before the debrief: it asks you to infer the mode from a 40-second loss.",
  },
  {
    type: "table",
    headers: ["Mode", "Loss window", "Main cost"],
    rows: [
      ["No persistence", "Everything since the last external copy", "Restart is empty; the refill path becomes the recovery"],
      ["RDB", "Since the last completed snapshot", "Fork and copy-on-write; minutes of loss at normal intervals"],
      ["AOF everysec", "About one second", "Append and background fsync; larger files"],
      ["AOF always", "None after acknowledgment", "fsync on every write; highest write latency"],
    ],
  },
  {
    type: "p",
    text: "The first question is what a lost write costs. If the answer is a recomputable cache entry, no persistence can be correct. If the answer is an order or a payment, the window must be explicit and tested. Choose the mode that meets that number, then verify the restart path with the real dataset.",
  },
  { type: "sim", simId: "redis-persistence" },
  { type: "experiment", experimentId: "predict-rdb-loss" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The RDB preset acknowledged writes that were only in memory. When the process stopped, everything after the last completed snapshot was gone. The loss window was the snapshot interval, and the number of lost writes scaled with the write rate. Redis itself was healthy before the crash; the failure was in the recovery point.",
  },
  {
    type: "p",
    text: "AOF everysec moved the window to about one second, and AOF always removed it. The cost appeared as write p99 and disk work, not as a cache error. Restart time stayed a separate constraint: a durable dataset can still take too long to load.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`INFO persistence`: `rdb_last_save_time`, `rdb_last_bgsave_status`, `aof_last_write_status`, and rewrite progress.",
      "The configured `save` points and `appendfsync` policy, which are often different from what the team believes.",
      "Write latency split into command time and fsync time, plus disk queue depth.",
      "Restart duration measured with the real dataset, not an empty test instance.",
      "Application reconciliation: records written near the crash that never reached the source of truth.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the last successful snapshot or fsync, then compare it with the crash time. Check whether the write was acknowledged before that point. Do not assume the configured interval matched the last completed save: a failed background save leaves the old snapshot in place.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Quantify the loss window and the write rate to get the number of records at risk.",
      "Decide whether those records are reconstructible; if they are, document the refill path and test it.",
      "If they are not, enable AOF everysec for a one-second window or AOF always when no loss is acceptable.",
      "Keep an RDB snapshot as well for faster restarts and backups if the dataset is large.",
      "Measure write p99 and restart time with the production dataset and disk.",
      "Add an alert on failed snapshots, failed AOF writes, and a stale last-save timestamp.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "RDB is compact and fast to load but its recovery point is minutes old at typical intervals.",
      "AOF everysec reduces loss to about a second and keeps write throughput high; it still permits that second.",
      "AOF always removes the window and pays an fsync on every acknowledged write.",
      "Running both costs disk and operational attention but gives fast restarts and a small loss window.",
      "No persistence is valid for reconstructible cache data only if the refill path is planned and tested.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "quantify-loss",
    question:
      "A product owner asks how many writes can be lost if Redis crashes. How do you answer?",
    difficulty: 2,
    hints: [
      "The loss window comes from the persistence mode, not from the crash.",
      "Multiply the window by the write rate, and check whether the writes are reconstructible.",
    ],
    answer:
      "I would state the mode and its window first: RDB loses writes since the last completed snapshot, AOF everysec risks about one second, AOF always acknowledges after fsync, and no persistence loses everything since the last external copy. Then I would multiply the window by the peak write rate to give a count, and separate acknowledged writes from data the application can rebuild. I would validate the last successful snapshot or fsync time, because a failed background save can make the real window wider than the configured one. The answer is a recovery point, not a percentage.",
    followUps: [
      "What if the writes are reconstructible from Kafka?",
      "How would a replica change the answer?",
      "What would you measure in a restore drill?",
    ],
    redFlags: [
      "Quotes a loss window without naming the mode.",
      "Assumes the configured interval is the actual recovery point.",
      "Treats all writes as equally valuable.",
    ],
    rubric: [
      "Names the mode-specific window.",
      "Converts the window to a write count.",
      "Checks the last successful persistence event.",
      "Separates reconstructible data.",
    ],
  },
  {
    id: "both-enabled",
    question:
      "RDB and AOF are both enabled. A restart happens. Which representation does Redis load, and why does it matter?",
    difficulty: 2,
    hints: [
      "Redis chooses the most complete representation.",
      "The AOF and RDB can be at different points in time.",
    ],
    answer:
      "Redis loads the AOF when both are enabled, because it is expected to be the most complete representation of the dataset. That matters because the recovery point is the AOF's last durable write, not the older RDB snapshot. If the AOF was disabled or failed silently, the instance may fall back to the RDB and lose more than the team expects. I would verify `INFO persistence` for both statuses and test the actual startup path, rather than assuming the presence of either file implies a particular recovery point.",
    followUps: [
      "What happens if the AOF is truncated?",
      "Why keep RDB at all if AOF is enabled?",
      "How would you test the startup choice safely?",
    ],
    redFlags: [
      "Assumes RDB always loads.",
      "Ignores AOF write failures.",
      "Tests only one file in staging.",
    ],
    rubric: [
      "States that AOF loads first.",
      "Ties it to the recovery point.",
      "Checks both persistence statuses.",
      "Tests the real startup path.",
    ],
  },
  {
    id: "choose-persistence",
    question:
      "You run a session cache and a leaderboard in Redis. Do they need the same persistence mode?",
    difficulty: 3,
    hints: [
      "Separate reconstructible cache data from data that exists only here.",
      "A single instance forces one mode on both datasets.",
    ],
    answer:
      "They have different recovery points. A session cache can often be rebuilt from the identity provider or allowed to expire, so no persistence or RDB may be enough. A leaderboard that is the source of truth for scores needs a smaller loss window, which points to AOF everysec or always. If both live in one instance, the stricter requirement wins unless I split them. I would also check whether replicas and backups cover the same window, and measure the restart path for the combined dataset. Splitting adds operational cost; sharing adds a durability compromise that must be explicit.",
    followUps: [
      "When would you split them into separate instances?",
      "How does the replica's persistence affect failover?",
      "What would you test before trusting the leaderboard's recovery?",
    ],
    redFlags: [
      "Applies the cache's mode to source-of-truth data.",
      "Adds AOF always without measuring write latency.",
      "Ignores failover and backup coverage.",
    ],
    rubric: [
      "Separates data classes by recovery point.",
      "States the stricter-requirement rule.",
      "Considers replicas and restores.",
      "Names the cost of splitting.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every Redis dataset has a stated recovery point and a loss budget.",
      "The persistence mode and fsync policy are visible in configuration review.",
      "Snapshots or AOF writes are monitored for failure, not only for completion.",
      "A restore drill measures both loss window and restart time.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the last successful snapshot or fsync before the crash.",
      "Estimate lost writes from the window and the write rate.",
      "Protect the source of truth and pause writes that cannot be reconstructed.",
      "Check whether a failed background save or disk error widened the window.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile acknowledged writes against the durable store.",
      "Change the mode or interval only after agreeing the new recovery point.",
      "Re-measure write latency and restart time with production-sized data.",
      "Record the remaining loss window in the runbook.",
    ],
  },
];

const references = [
  {
    title: "Redis persistence",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "RDB, AOF, fsync policies, and the everysec loss window.",
  },
  {
    title: "Redis replication",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/replication/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "How persistence and replication interact during failover.",
  },
  {
    title: "INFO command",
    url: "https://redis.io/docs/latest/commands/info/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Persistence and memory fields used in the checklist.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "redis-persistence": {
      model: redisPersistenceModel,
      presets,
      instructions:
        "Start healthy, apply RDB only, then compare AOF everysec and AOF always. Watch the loss window and write p99 together; recovery time is a separate budget.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The load rates are teaching values. The loss-window behavior follows the documented persistence modes: RDB since the last snapshot, AOF everysec about one second, AOF always none.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["caching-redis-data-types", "caching-read-replicas", "caching-warming"],
};
