import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AUTOSCALE_THRESHOLD = 0.9;
const AUTOSCALE_COOLDOWN = 20;

const params = [
  {
    id: "usedGb",
    label: "Used storage",
    min: 50,
    max: 2_000,
    step: 10,
    value: 400,
    unit: " GB",
    group: "Storage",
    help: "Data currently on the volume. It includes tables, indexes, WAL, and temporary files.",
    format: "number" as const,
  },
  {
    id: "growthGbPerHour",
    label: "Growth rate",
    min: 0,
    max: 600,
    step: 10,
    value: 20,
    unit: " GB/h",
    group: "Storage",
    help: "Net growth per hour. A bulk load or a long sort can make this spike far above the daily average.",
    format: "number" as const,
  },
  {
    id: "maxGb",
    label: "Autoscaling maximum",
    min: 100,
    max: 4_000,
    step: 100,
    value: 1_000,
    unit: " GB",
    group: "Autoscaling",
    help: "The largest volume the autoscaling policy may allocate. At this cap, growth becomes a write outage.",
    format: "number" as const,
  },
  {
    id: "autoscaleEnabled",
    label: "Autoscaling enabled",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Autoscaling",
    help: "1 lets the volume grow toward the maximum when free space is low. 0 keeps the initial allocation fixed.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return Number.isFinite(value) ? (value as number) : fallback;
}

interface State {
  used: number;
  volume: number;
  lastGrow: number;
}

function initialState(p: Params): State {
  const max = Math.max(100, num(p, "maxGb", 1_000));
  const used = clamp(num(p, "usedGb", 400), 0, max);
  const volume = Math.min(max, Math.max(100, Math.ceil((used * 1.5) / 10) * 10));
  return { used, volume, lastGrow: -AUTOSCALE_COOLDOWN };
}

interface Computed {
  used: number;
  volume: number;
  max: number;
  growth: number;
  autoscale: boolean;
  usedPct: number;
  free: number;
  writeErrors: number;
  hoursToFull: number;
  health: Health;
}

function compute(p: Params, state: State): Computed {
  const max = Math.max(100, num(p, "maxGb", 1_000));
  const growth = Math.max(0, num(p, "growthGbPerHour", 20));
  const autoscale = num(p, "autoscaleEnabled", 1) >= 0.5;
  const usedPct = (state.used / Math.max(1, state.volume)) * 100;
  const free = Math.max(0, state.volume - state.used);
  const writeErrors = usedPct >= 99.9 ? 100 : usedPct >= 95 ? 5 : 0;
  const health: Health = writeErrors >= 10 || usedPct >= 95 ? "crit" : usedPct >= 80 ? "warn" : "ok";
  return {
    used: state.used,
    volume: state.volume,
    max,
    growth,
    autoscale,
    usedPct,
    free,
    writeErrors,
    hoursToFull: growth > 0 ? free / growth : Number.POSITIVE_INFINITY,
    health,
  };
}

function nextState(p: Params, state: State, t: number, dt: number): State {
  const max = Math.max(100, num(p, "maxGb", 1_000));
  const growth = Math.max(0, num(p, "growthGbPerHour", 20));
  const autoscale = num(p, "autoscaleEnabled", 1) >= 0.5;
  let volume = Math.min(max, state.volume);
  let lastGrow = state.lastGrow;
  const used = Math.min(volume, state.used + (growth * dt) / 3_600);
  if (
    autoscale &&
    volume < max &&
    used / volume >= AUTOSCALE_THRESHOLD &&
    t - lastGrow >= AUTOSCALE_COOLDOWN
  ) {
    const increment = Math.max(50, Math.ceil((volume * 0.1) / 10) * 10);
    volume = Math.min(max, volume + increment);
    lastGrow = t;
  }
  return { used, volume, lastGrow };
}

function formatGb(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} GB`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["used-pct", values.usedPct, 0.3],
    ["write-errors", values.writeErrors, 0],
    ["free-gb", values.free, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, (Number.isFinite(value) ? value : 0) * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, state: State, seed: number, t: number): SimFrame {
  const values = compute(p, state);
  return {
    t,
    nodes: [
      {
        id: "writer",
        label: "Database writer",
        kind: "db",
        role: "primary",
        health: values.health,
        sublabel: values.writeErrors >= 10 ? "writes failing" : "accepting writes",
        detail:
          "When the volume has no free space, writes fail and the instance can become unstable. Autoscaling delays this only if capacity remains below the maximum.",
        meta: { view: "flow" },
      },
      {
        id: "volume",
        label: "Storage volume",
        kind: "storage",
        health: values.health,
        utilization: clamp(values.usedPct / 100),
        sublabel: `${formatGb(values.used)} of ${formatGb(values.volume)}`,
        detail: `The volume is ${values.usedPct.toFixed(
          1,
        )}% used with ${formatGb(values.free)} free. Autoscaling increases the allocation; it does not delete data or shrink the volume.`,
        meta: { view: "flow", used: values.used, volume: values.volume },
      },
      {
        id: "temp",
        label: "Temporary files",
        kind: "storage",
        health: values.writeErrors >= 10 ? "crit" : "ok",
        sublabel: "sorts, vacuum, WAL",
        detail:
          "Large sorts, vacuum, and write-ahead log growth consume the same volume as tables. A temporary spike can fill the disk even when the permanent data is flat.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("writer-volume", "writer", "volume", clamp(values.usedPct / 100), values.health, "writes"),
      edge("temp-volume", "temp", "volume", clamp(values.usedPct / 100), values.writeErrors >= 10 ? "crit" : "ok", "temporary"),
    ],
    metrics: [
      metric("used-pct", "Storage used", values.usedPct, "%", 80, 95, "percent"),
      metric("write-errors", "Write errors", values.writeErrors, "%", 1, 10, "percent"),
      metric("free-gb", "Free space", values.free, " GB", undefined, undefined, "number"),
      metric("volume-gb", "Allocated volume", values.volume, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatGb(values.used)} of ${formatGb(values.volume)} used (${values.usedPct.toFixed(
      1,
    )}%); ${formatGb(values.free)} free; growth ${values.growth} GB/h; cap ${formatGb(values.max)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "used-pct",
    metricId: "used-pct",
    warn: 80,
    crit: 95,
    title: "The storage volume is nearly full",
    cause:
      "Data, indexes, WAL, and temporary files share one volume. Autoscaling adds space only while the allocation is below its maximum, and a fast growth rate can outrun the increments.",
    fix:
      "Free space or add capacity before the cap: lower retention, clean temporary files, add storage or raise the maximum, and move large batch work off the primary.",
    checkFirst: [
      "Compare used space with the autoscaling maximum.",
      "Check temporary files, WAL, and vacuum, not just table size.",
      "Check how fast the volume grew over the last hour.",
    ],
  },
  {
    id: "write-errors",
    metricId: "write-errors",
    warn: 1,
    crit: 10,
    title: "Writes are failing because the disk is full",
    cause:
      "The volume reached its allocated size and could not grow further, so the engine cannot write WAL, sort files, or new rows.",
    fix:
      "Emergency-free space, raise the cap if the underlying limit allows, and restore service. Then fix the growth source so the next spike does not repeat.",
    checkFirst: [
      "Check the autoscaling maximum and whether it was reached.",
      "Check for a runaway query, a bulk load, or a retention job that stopped.",
      "Check free space at the filesystem and tablespace level.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const storageModel: SimModel = {
  id: "databases-storage-autoscaling",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const state = initialState(defaults());
    const frame = buildFrame(defaults(), state, seed, 0);
    seedSeries(frame, compute(defaults(), state), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const first = frame.flags.stateInit !== 1;
    const seed = Number(frame.flags.seed ?? 20261110);
    const t = frame.t + dt;
    const previous: State = first
      ? initialState(p)
      : {
          used: Number(frame.flags.usedGb ?? 0),
          volume: Number(frame.flags.volumeGb ?? 0),
          lastGrow: Number(frame.flags.lastGrow ?? 0),
        };
    const state = nextState(p, previous, t, dt);
    const values = compute(p, state);
    const next = buildFrame(p, state, seed, t);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      usedGb: state.used,
      volumeGb: state.volume,
      lastGrow: state.lastGrow,
      stateInit: 1,
    };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.writeErrors >= 10 && frame.flags.fullLogged !== 1) {
      pushEvent(next, {
        id: "storage-full",
        at: t,
        severity: "crit",
        title: "Autoscaling cap reached; writes fail",
        detail: `${formatGb(values.used)} used on a ${formatGb(values.volume)} volume with a ${formatGb(
          values.max,
        )} maximum. No free space remains for writes or temporary files.`,
        nodeId: "volume",
        metricId: "write-errors",
      });
    }
    next.flags.fullLogged = values.writeErrors >= 10 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const state: State =
      frame.flags.stateInit === 1
        ? {
            used: Number(frame.flags.usedGb ?? 0),
            volume: Number(frame.flags.volumeGb ?? 0),
            lastGrow: Number(frame.flags.lastGrow ?? 0),
          }
        : initialState(p);
    const initial = compute(p, state);
    return [
      `The volume starts at ${formatGb(initial.volume)} with ${formatGb(initial.used)} used, or ${initial.usedPct.toFixed(
        1,
      )}%. The maximum is ${formatGb(initial.max)}.`,
      Number.isFinite(initial.hoursToFull)
        ? `At ${initial.growth} GB/h, the free space lasts about ${initial.hoursToFull.toFixed(
            1,
          )} hours if the growth rate holds and autoscaling has room to grow.`
        : "With no growth, the volume does not fill from this workload. Temporary files and batch jobs can still spike it.",
      initial.autoscale
        ? "Autoscaling adds capacity when free space is low, in increments and with a cooldown. It stops at the maximum and never shrinks the volume."
        : "Autoscaling is off, so the initial allocation is the hard limit. Any growth is on a path to a full disk.",
      "Separate permanent data growth from temporary growth. A retention cleanup or a smaller sort can remove the spike without adding permanent capacity.",
      "The alarm that matters is free space and time-to-full, not only the used percentage. A 90% volume with slow growth and a 99% volume with fast growth need different responses.",
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
    description: "A 600 GB volume at 67% with slow growth and plenty of room below the 1 TB cap.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Bulk load",
    description: "An 820 GB volume on a 1 TB allocation grows at 120 GB/h and enters warning, but autoscaling still has room.",
    tone: "warn",
    params: defaults({ usedGb: 820, growthGbPerHour: 120, maxGb: 1_000, autoscaleEnabled: 1 }),
  },
  {
    id: "failure",
    label: "Cap reached",
    description: "The volume is at the 1 TB maximum with almost no free space, so writes fail and autoscaling cannot add more.",
    tone: "crit",
    params: defaults({ usedGb: 998, growthGbPerHour: 300, maxGb: 1_000, autoscaleEnabled: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Retention cleanup and a smaller batch cut growth to 10 GB/h with a 2 TB ceiling.",
    tone: "ok",
    params: defaults({ usedGb: 200, growthGbPerHour: 10, maxGb: 2_000, autoscaleEnabled: 1 }),
  },
];

const experiment: Experiment = {
  id: "disk-full-at-the-cap",
  title: "What happens when growth reaches the maximum",
  simId: "storage-autoscaling",
  question:
    "A 1 TB volume with autoscaling enabled has a 1 TB maximum. It is 99% full and growing at 300 GB/h. What happens next?",
  prediction: {
    options: [
      { id: "grow", label: "Autoscaling adds another 10% and writes continue." },
      { id: "shrink", label: "Autoscaling compacts old data to make room." },
      { id: "fail", label: "The cap blocks more allocation, free space reaches zero, and writes fail." },
      { id: "backup", label: "The backup window pauses growth until the volume is restored." },
    ],
    correctOptionId: "fail",
    explanation:
      "Autoscaling can only allocate up to the configured maximum. Once the volume is there, low free space has nowhere to go. Temporary files and WAL can consume the last blocks quickly, and then the engine cannot write. Autoscaling never deletes or compacts data, and backups do not stop the primary's growth.",
  },
  setup: defaults({ usedGb: 998, growthGbPerHour: 300, maxGb: 1_000, autoscaleEnabled: 1 }),
  runFor: 40,
  observe: [
    "Used storage starts at 99.8% and reaches the 1 TB allocation within the run.",
    "Free space goes to zero; autoscaling cannot exceed the 1 TB maximum.",
    "Write errors cross 10% and the writer turns critical.",
    "The volume is at the cap, not merely busy; the fix is to free space or raise the maximum.",
  ],
  explain:
    "Autoscaling is a bounded response to growth. It buys time between the current volume and the maximum, but it cannot create space beyond that maximum or shrink data. A fast growth rate, a stalled retention job, or a large sort can exhaust the remaining headroom before an operator can react.",
  fix: defaults({ usedGb: 700, growthGbPerHour: 40, maxGb: 2_000, autoscaleEnabled: 1 }),
  debrief:
    "With a 2 TB ceiling and 40 GB/h growth, the 700 GB volume starts at 47% and has room for both autoscaling and an operator response. The cap is now a safety limit instead of the failure point. The remaining work is retention and temporary-file control, because a cap only decides when the outage happens.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Storage autoscaling increases a database volume's allocated size when free space runs low, up to a configured maximum. In Amazon RDS, the setting is on the instance and the new storage is added in increments; Aurora grows its cluster volume automatically, but the lessons about growth rate and temporary files still apply.",
  },
  {
    type: "p",
    text: "Autoscaling is not unlimited. The maximum is a hard ceiling, and once the volume is there the policy cannot add more. It also does not delete data, shrink the volume, or stop a runaway sort. It buys time between the current allocation and the cap. Whether that time is enough depends on the growth rate and on how quickly an operator can respond.",
  },
  {
    type: "p",
    text: "Growth has two shapes. Permanent growth comes from new rows, indexes, and retained history. Temporary growth comes from sorts, hash joins, vacuum, write-ahead log (WAL), and bulk loads. Temporary files can fill the volume in minutes and then disappear, which is why a chart of table size alone can miss the incident.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The database writes rows, indexes, and WAL to the volume. A large query can spill sorts or hashes to temporary files on the same volume. Autoscaling watches free space and requests more allocation when the threshold is crossed. The operating system, the engine, and the storage service all have to complete that change before the next write can use the new space.",
  },
  {
    type: "table",
    headers: ["Consumer", "Permanent?", "What to check"],
    rows: [
      ["Tables and indexes", "Yes", "Growth rate, bloat, retention"],
      ["WAL", "Mostly transient", "Write rate, replication slots, archive lag"],
      ["Sort and hash files", "No", "Large queries, work_mem, concurrency"],
      ["Vacuum and temporary files", "No", "Autovacuum, long transactions"],
      ["Backups and snapshots", "Separate storage", "Retention, not the primary volume"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Storage used: warning at 80% and critical at 95% in this model.",
      "Write errors: warning at 1% and critical at 10% as free space runs out.",
      "Free space and allocated volume, which together show how much autoscaling has left.",
      "Growth rate and the autoscaling maximum, which determine time to the cap.",
      "A temporary-files node, because the volume does not care why the bytes arrived.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Cap reached. Watch free space, not just the used percentage. Raise the maximum and lower growth to see the cap stop being the failure point. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Volume sizes, growth rates, and thresholds are illustrative teaching numbers. Real autoscaling increments, cooldowns, and maximums depend on the service and the volume type; check the current documentation before relying on a specific value.",
  },
  { type: "sim", simId: "storage-autoscaling" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The volume was already at 99.8% of a 1 TB allocation with a 1 TB maximum. Autoscaling had no room to add capacity, so the remaining free space went to zero as growth continued. Once the engine could not write WAL or new rows, write errors crossed 10% and the writer turned critical. The cap, not the growth rate, decided when the outage began.",
  },
  {
    type: "p",
    text: "Raising the maximum to 2 TB and cutting growth to 40 GB/h changed the timeline. The volume started at 47%, autoscaling had room to add increments, and an operator had hours rather than minutes to act. The cap became a safety limit instead of the failure point.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Free storage space and the allocated volume size over time, not just the percentage.",
      "Autoscaling events and the configured maximum; if the volume is at the maximum, autoscaling is not coming to help.",
      "Temporary file usage, WAL size, replication slot lag, and vacuum activity.",
      "Write errors, read-only mode, and engine log messages about disk space.",
      "Retention job status and the age of the oldest rows, which explain permanent growth.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare used space with the autoscaling maximum. If the volume is at the cap, free space or raise the cap immediately. Then find the growth source: permanent rows, WAL, a stalled retention job, or a temporary sort. The used percentage alone does not tell you which response is safe.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the growth: cancel or throttle a runaway query or bulk load, and clean temporary files if the engine allows it.",
      "Free space with retention or archival, but verify that the cleanup does not break queries or backups.",
      "Raise the maximum or add storage if the underlying limit allows, and confirm the change completed.",
      "Fix the growth source: retention jobs, batch schedules, vacuum settings, or query memory.",
      "Set alarms on free space and time-to-full, with a warning early enough to act before the cap.",
      "Re-test the autoscaling path after the change, including the time it takes to add capacity.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher maximum protects against a spike but costs more for allocated storage and can hide a growth problem.",
      "A lower maximum limits cost but turns growth into an outage sooner.",
      "Aggressive retention frees space but can break audit or product requirements.",
      "Autoscaling adds capacity quickly but cannot remove it, so over-provisioning persists.",
      "Moving batch work off the primary reduces temporary growth but adds a separate system to operate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "time-to-full",
    question: "A volume has 120 GB free and is growing at 40 GB/h. Autoscaling has a 2 TB cap and the current allocation is 1.9 TB. What do you do?",
    difficulty: 2,
    hints: [
      "Compute the time to full and the room to the cap.",
      "The cap is closer than the growth rate suggests.",
    ],
    answer:
      "The volume has 120 GB free and autoscaling has 100 GB of room to the 2 TB cap, so the effective headroom is about 220 GB. At 40 GB/h that is roughly 5.5 hours, minus any temporary growth. I would act now: find and stop the growth source, free space with retention if safe, and raise the cap if the service allows. Waiting for autoscaling alone would hit the cap in a few hours.",
    followUps: [
      "What would change if growth were temporary?",
      "Which alarm would you add?",
      "How would you verify the cap change took effect?",
    ],
    redFlags: [
      "Assumes autoscaling is unlimited.",
      "Uses only the used percentage.",
      "Waits for the disk to fill.",
    ],
    rubric: [
      "Computes headroom to the cap.",
      "Estimates time to full.",
      "Finds the growth source.",
      "Raises the cap or frees space.",
    ],
  },
  {
    id: "temp-vs-permanent",
    question: "How do you tell temporary file growth from permanent data growth?",
    difficulty: 3,
    hints: [
      "Compare table size with volume size over time.",
      "Look at query and vacuum activity.",
    ],
    answer:
      "I would compare the volume's used space with the sum of table and index sizes over the same window. If the volume rises while table size is flat, the difference is temporary files, WAL, or bloat. I would check pg_stat_activity for large sorts and hashes, pg_stat_database for temp_bytes, WAL generation, replication slots, and vacuum progress. Temporary growth calls for query or memory tuning; permanent growth calls for retention, archival, or more capacity.",
    followUps: [
      "Which PostgreSQL view shows temporary bytes?",
      "What does a replication slot do to WAL?",
      "When would you add storage instead of tuning?",
    ],
    redFlags: [
      "Assumes all growth is table data.",
      "Ignores WAL and replication slots.",
      "Adds storage without finding the source.",
    ],
    rubric: [
      "Compares table size with volume size.",
      "Names temporary files and WAL.",
      "Uses engine views.",
      "Matches the fix to the source.",
    ],
  },
  {
    id: "cap-planning",
    question: "How do you choose the autoscaling maximum?",
    difficulty: 3,
    hints: [
      "Start from growth and response time.",
      "Leave room for temporary spikes and recovery.",
    ],
    answer:
      "I would start from the observed growth rate and the time needed to respond to an alert, then add headroom for temporary files and batch spikes. The maximum should be high enough that the volume does not reach it before an operator can act, but not so high that it hides a runaway growth problem. I would also check the service's volume and instance limits, and alarm on free space and time-to-full rather than only on the percentage.",
    followUps: [
      "How does the response time change the maximum?",
      "What would make you lower the maximum?",
      "How would you test the alert?",
    ],
    redFlags: [
      "Sets the maximum to the service maximum by default.",
      "Ignores temporary growth.",
      "Alarms only at 95%.",
    ],
    rubric: [
      "Uses growth and response time.",
      "Adds temporary headroom.",
      "Checks service limits.",
      "Alarms on free space and time.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Free space and time-to-full are alarmed, not just the used percentage.",
      "The autoscaling maximum is documented with the response time it buys.",
      "Retention and archival jobs are monitored for failure.",
      "Temporary file and WAL growth are charted separately from table size.",
      "A storage-full runbook names who can raise the cap and how.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare free space with the cap before assuming autoscaling will save you.",
      "Stop runaway queries or bulk loads that are consuming temporary space.",
      "Free space with retention only if it is safe and reversible.",
      "Raise the cap or add storage, then confirm the allocation changed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the growth source and re-check the cap against the new rate.",
      "Verify backups and replication after the cleanup.",
      "Record the time from alert to full and the action that worked.",
      "Update the alarm threshold with the measured response time.",
    ],
  },
];

const references = [
  {
    title: "Amazon RDS storage autoscaling",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIOPS.StorageTypes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Storage autoscaling behavior, maximum storage threshold, and volume limits.",
  },
  {
    title: "Amazon Aurora storage",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.StorageReliability.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How Aurora stores data across Availability Zones and grows the cluster volume.",
  },
  {
    title: "PostgreSQL: Monitoring Disk Usage",
    url: "https://www.postgresql.org/docs/current/diskusage.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Table, index, and temporary file sizing, and the views used to find disk consumers.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "storage-autoscaling": {
      model: storageModel,
      presets,
      instructions:
        "Start healthy, apply Cap reached, and watch free space rather than only the used percentage. Raise the maximum and lower growth to see the cap stop being the failure point. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Volume sizes, growth rates, increments, and thresholds are teaching values, not RDS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-backups-pitr",
    "databases-vacuum-bloat",
    "databases-aurora-global",
    "foundations-capacity-headroom",
  ],
};
