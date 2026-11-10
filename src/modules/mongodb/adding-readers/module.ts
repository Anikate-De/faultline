import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRIMARY_CAPACITY = 20_000;
const EXISTING_SECONDARY_CAPACITY = 18_000;
const NEW_SECONDARY_READ_CAPACITY = 9_000;
const SYNC_OPS = 3_500;
const REPLICATION_OPS = 300;
const WARM_SECONDS = 30;
const MAX_RPS = 40_000;

const params = [
  {
    id: "requestRate",
    label: "Primary operation rate",
    min: 4_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Reads and writes arriving at the primary before any new member is added.",
    format: "rps" as const,
  },
  {
    id: "writeShare",
    label: "Write share",
    min: 5,
    max: 60,
    step: 5,
    value: 25,
    unit: "%",
    group: "Traffic",
    help: "Share of operations that are writes. Writes drive oplog replication and cost more primary work.",
    format: "percent" as const,
  },
  {
    id: "newSecondaries",
    label: "New secondaries",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Topology",
    help: "Members added to the replica set. Each one must finish initial sync before it can serve reads.",
    format: "count" as const,
  },
  {
    id: "readOffload",
    label: "Reads routed to new members",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Routing",
    help: "Share of reads sent to the new secondaries. Routing starts only after a member reaches SECONDARY.",
    format: "percent" as const,
  },
  {
    id: "syncSource",
    label: "Initial sync source",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Topology",
    help: "0 = primary, 1 = eligible secondary. MongoDB uses `initialSyncSourceReadPreference`, a `mongod` startup parameter that accepts read preference modes; this model collapses them to primary vs secondary. A secondary source moves sync reads off the primary but loads that secondary.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface SyncState {
  active: number;
  startedAt: number;
  doneAt: number;
  complete: boolean;
  warmStartedAt: number;
  elapsed: number;
  progress: number;
  warm: number;
  source: number;
}

function syncDuration(active: number): number {
  if (active <= 0) return 0;
  return 24 + 12 * active;
}

function initialSyncState(p: Params): SyncState {
  const active = Math.round(num(p, "newSecondaries", 0));
  return {
    active,
    startedAt: 0,
    doneAt: -1,
    complete: false,
    warmStartedAt: -1,
    elapsed: 0,
    progress: 0,
    warm: 0,
    source: Math.round(num(p, "syncSource", 0)),
  };
}

function readSyncState(frame: SimFrame, p: Params): SyncState {
  const active = Math.round(num(p, "newSecondaries", 0));
  const previous = Math.round(Number(frame.flags.activeSecondaries ?? 0));
  const source = Math.round(num(p, "syncSource", 0));
  const previousSource = Math.round(Number(frame.flags.syncSource ?? 0));
  let startedAt = Number(frame.flags.syncStartedAt ?? 0);
  let doneAt = Number(frame.flags.syncDoneAt ?? -1);
  let complete = Number(frame.flags.syncComplete ?? 0) === 1;
  let warmStartedAt = Number(frame.flags.warmStartedAt ?? -1);

  if (active !== previous || source !== previousSource) {
    startedAt = frame.t;
    doneAt = -1;
    complete = false;
    warmStartedAt = -1;
  }
  if (active === 0) {
    startedAt = 0;
    doneAt = -1;
    complete = false;
    warmStartedAt = -1;
  }

  const duration = syncDuration(active);
  const elapsed = active > 0 ? Math.max(0, frame.t - startedAt) : 0;
  const progress = duration > 0 ? clamp(elapsed / duration) : 0;
  if (active > 0 && progress >= 1) {
    if (!complete) doneAt = startedAt + duration;
    complete = true;
  }

  const offload = num(p, "readOffload", 0);
  if (complete && offload > 0) {
    if (warmStartedAt < 0) warmStartedAt = frame.t;
  } else if (offload <= 0) {
    warmStartedAt = -1;
  }
  const warm = warmStartedAt >= 0 ? clamp((frame.t - warmStartedAt) / WARM_SECONDS) : 0;

  return { active, startedAt, doneAt, complete, warmStartedAt, elapsed, progress, warm, source };
}

interface Computed {
  requestRate: number;
  writeShare: number;
  writeRps: number;
  readRps: number;
  effectiveOffload: number;
  primaryCpu: number;
  primaryP99: number;
  replicaLag: number;
  existingSecondaryCpu: number;
  sourceCpu: number;
  newCpu: number;
  newP99: number;
  newReadRps: number;
  syncProgress: number;
  syncRamp: number;
}

function compute(p: Params, state: SyncState): Computed {
  const requestRate = num(p, "requestRate", 12_000);
  const writeShare = clamp(num(p, "writeShare", 25) / 100, 0, 1);
  const writeRps = requestRate * writeShare;
  const readRps = requestRate - writeRps;
  const offload = clamp(num(p, "readOffload", 0) / 100, 0, 1);
  const syncing = state.complete ? 0 : state.active;
  const syncRamp = state.active > 0 ? clamp(state.elapsed / 8) : 0;
  const effectiveOffload = state.complete ? offload : 0;
  const sourceSecondary = state.source === 1;

  const syncReadLoad = SYNC_OPS * syncing * syncRamp;
  const syncOverhead = sourceSecondary ? 0 : syncReadLoad;
  const replicationOverhead = state.active * REPLICATION_OPS;
  const primaryWork =
    requestRate * (1 + writeShare * 0.5) -
    readRps * effectiveOffload +
    syncOverhead +
    replicationOverhead;
  const primaryCpu = clamp((primaryWork / PRIMARY_CAPACITY) * 100, 0, 140);
  const existingSecondaryCpu = clamp(25 + writeShare * 25, 0, 140);
  const sourceCpu = sourceSecondary
    ? clamp(existingSecondaryCpu + (syncReadLoad / EXISTING_SECONDARY_CAPACITY) * 100, 0, 140)
    : 0;

  const cpuRatio = primaryCpu / 100;
  const primaryP99 =
    primaryCpu >= 100
      ? 254 + (primaryCpu - 100) * 10
      : 4 + (90 * cpuRatio ** 5) / Math.max(0.04, 1 - cpuRatio);

  const baseLag = 0.2 + writeRps * 0.000015;
  const syncLag = syncing * syncRamp * (3.5 + 2.5 * (1 - state.progress));
  const coldLag = state.complete ? offload * 0.8 : 0;
  const replicaLag = baseLag + syncLag + coldLag;

  const newReadRps = (readRps * effectiveOffload) / Math.max(1, state.active);
  const readCpu = (newReadRps / NEW_SECONDARY_READ_CAPACITY) * 100;
  const syncCpu = syncing > 0 ? 40 + 25 * syncRamp : 0;
  const newCpu = Math.max(syncCpu, readCpu);
  const newP99 =
    state.complete && offload > 0
      ? 8 + 20 * (newCpu / 100) ** 2 + 130 * (1 - state.warm)
      : 0;

  return {
    requestRate,
    writeShare,
    writeRps,
    readRps,
    effectiveOffload,
    primaryCpu,
    primaryP99: Math.min(900, primaryP99),
    replicaLag,
    existingSecondaryCpu,
    sourceCpu,
    newCpu,
    newP99: Math.min(400, newP99),
    newReadRps,
    syncProgress: state.progress * 100,
    syncRamp,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function cpuHealth(cpu: number): Health {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function lagHealth(lag: number): Health {
  if (lag >= 10) return "crit";
  if (lag >= 6) return "warn";
  return "ok";
}

function latencyHealth(p99: number, warn: number, crit: number): Health {
  if (p99 >= crit) return "crit";
  if (p99 >= warn) return "warn";
  return "ok";
}

function formatLag(seconds: number): string {
  return seconds < 1 ? `${(seconds * 1000).toFixed(0)}ms` : `${seconds.toFixed(1)}s`;
}

function formatCpu(cpu: number): string {
  return cpu >= 100 ? "100+%" : `${cpu.toFixed(0)}%`;
}

function buildFrame(seed: number, state: SyncState, values: Computed): SimFrame {
  const primaryHealth = worst(
    cpuHealth(values.primaryCpu),
    latencyHealth(values.primaryP99, 80, 250),
  );
  const replica1Cpu = state.source === 1 ? values.sourceCpu : values.existingSecondaryCpu;
  const replica1Health = worst(cpuHealth(replica1Cpu), lagHealth(values.replicaLag));
  const replica2Health = worst(cpuHealth(values.existingSecondaryCpu), lagHealth(values.replicaLag));
  const newHealth =
    state.active > 0
      ? state.complete && values.newP99 > 0
        ? latencyHealth(values.newP99, 50, 100)
        : lagHealth(values.replicaLag)
      : "ok";

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: "ok",
      sublabel: `${Math.round(values.requestRate).toLocaleString()} ops/s`,
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: primaryHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.requestRate,
      sublabel: `${formatCpu(values.primaryCpu)} CPU · p99 ${values.primaryP99.toFixed(0)}ms`,
      detail: `Illustrative primary capacity: ${PRIMARY_CAPACITY.toLocaleString()} ops/s. Writes cost more per operation in this model. Initial sync adds read and network work before the new member can help.`,
      meta: { view: "flow" },
    },
    {
      id: "replica-1",
      label: "Secondary A",
      kind: "db",
      role: "replica",
      health: replica1Health,
      utilization: clamp(replica1Cpu / 100),
      throughput: values.writeRps,
      sublabel: `${state.source === 1 ? "sync source · " : ""}lag ${formatLag(values.replicaLag)}`,
      detail:
        state.source === 1
          ? "Selected as the initial sync source. It carries sync reads in addition to replication writes, so its CPU and lag can become the new constraint."
          : "An existing secondary receives the same write stream and is a candidate sync source. Its lag is the freshness budget for read preference.",
      meta: { view: "flow", lag: values.replicaLag },
    },
    {
      id: "replica-2",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: replica2Health,
      utilization: clamp(values.existingSecondaryCpu / 100),
      throughput: values.writeRps,
      sublabel: `lag ${formatLag(values.replicaLag)}`,
      detail: "The second existing secondary gives the set a fault-tolerant majority. It is also a candidate sync source and a read target.",
      meta: { view: "flow", lag: values.replicaLag },
    },
  ];

  for (let index = 1; index <= state.active; index++) {
    const syncing = !state.complete;
    nodes.push({
      id: `new-replica-${index}`,
      label: `New secondary ${index}`,
      kind: "db",
      role: "replica",
      health: newHealth,
      utilization: clamp(values.newCpu / 100),
      throughput: syncing ? SYNC_OPS * values.syncRamp : values.newReadRps,
      sublabel: syncing
        ? `initial sync ${values.syncProgress.toFixed(0)}%`
        : values.newP99 > 0
          ? `cold reads · p99 ${values.newP99.toFixed(0)}ms`
          : "synced · no reads",
      detail: syncing
        ? `Initial sync is ${values.syncProgress.toFixed(0)}% complete. The member is in STARTUP2 and cannot serve application reads yet. The sync source is ${state.source === 1 ? "Secondary A" : "the primary"}.`
        : `Sync complete. Cache warmth in this model is ${(state.warm * 100).toFixed(0)}%; cold reads hit disk and raise p99.`,
      meta: { view: "flow", lag: values.replicaLag, sync: values.syncProgress },
    });
  }

  const edges = [
    edge("client-primary", "client", "primary", values.requestRate / MAX_RPS, primaryHealth),
    edge("primary-replica-1", "primary", "replica-1", values.writeRps / MAX_RPS, replica1Health),
    edge("primary-replica-2", "primary", "replica-2", values.writeRps / MAX_RPS, replica2Health),
    ...Array.from({ length: state.active }, (_, index) => {
      const id = `new-replica-${index + 1}`;
      return edge(`primary-${id}`, "primary", id, values.writeRps / MAX_RPS, newHealth);
    }),
    ...Array.from({ length: state.active }, (_, index) => {
      const id = `new-replica-${index + 1}`;
      return edge(
        `sync-${id}`,
        state.source === 1 ? "replica-1" : "primary",
        id,
        (state.complete ? 0 : SYNC_OPS * values.syncRamp) / MAX_RPS,
        state.source === 1 ? replica1Health : primaryHealth,
      );
    }),
    ...Array.from({ length: state.active }, (_, index) => {
      const id = `new-replica-${index + 1}`;
      return edge(
        `client-${id}`,
        "client",
        id,
        (values.readRps * values.effectiveOffload) / Math.max(1, state.active) / MAX_RPS,
        newHealth,
      );
    }),
  ];

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("primary-cpu", "Primary CPU", values.primaryCpu, "%", 70, 85, "percent"),
      metric("primary-p99", "Primary p99", values.primaryP99, "ms", 80, 250, "ms"),
      metric("replication-lag", "Replication lag", values.replicaLag, "s", 6, 10, "number"),
      metric("sync-source-cpu", "Secondary sync-source CPU", values.sourceCpu, "%", 70, 85, "percent"),
      metric("new-secondary-p99", "New secondary p99", values.newP99, "ms", 50, 100, "ms"),
      metric("new-secondary-cpu", "New secondary CPU", values.newCpu, "%", 75, 90, "percent"),
      metric("sync-progress", "Initial sync progress", values.syncProgress, "%", undefined, undefined, "percent"),
      metric("effective-offload", "Effective read offload", values.effectiveOffload * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      activeSecondaries: state.active,
      syncStartedAt: state.startedAt,
      syncDoneAt: state.doneAt,
      syncComplete: state.complete ? 1 : 0,
      warmStartedAt: state.warmStartedAt,
      syncSource: state.source,
      syncAnnounced: 0,
      syncCompleteEvent: 0,
      coldReadAnnounced: 0,
    },
    summary: `${formatCpu(values.primaryCpu)} primary CPU · p99 ${values.primaryP99.toFixed(0)}ms · lag ${formatLag(values.replicaLag)} · sync ${values.syncProgress.toFixed(0)}%`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 11)) / 2.7);
  const series: [string, number][] = [
    ["primary-cpu", values.primaryCpu],
    ["primary-p99", values.primaryP99],
    ["replication-lag", values.replicaLag],
    ["new-secondary-p99", values.newP99],
    ["new-secondary-cpu", values.newCpu],
    ["sync-progress", values.syncProgress],
    ["effective-offload", values.effectiveOffload * 100],
    ["sync-source-cpu", values.sourceCpu],
    ["cpu.primary", values.primaryCpu],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * Math.max(0.1, value * 0.015)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "primary-cpu",
    metricId: "primary-cpu",
    warn: 70,
    crit: 85,
    title: "The primary is saturating",
    cause: "The primary is carrying production reads and writes, plus any initial sync and replication work. A new member adds sync load before it adds read capacity.",
    fix: "If a sync is running, move it to a secondary source with headroom by setting `initialSyncSourceReadPreference`, or wait for a low-traffic window. If the primary is simply undersized, reduce work or add capacity. Do not add more readers while the primary is saturated.",
    checkFirst: [
      "Check per-member CPU and disk I/O, not the replica set average.",
      "Check initial sync progress and the selected sync source.",
      "Check whether the primary is write-bound before adding a reader.",
    ],
  },
  {
    id: "primary-p99",
    metricId: "primary-p99",
    warn: 80,
    crit: 250,
    title: "Primary latency is queueing",
    cause: "The primary is near its capacity, from production load or initial sync or both. Small additions create large latency increases once the queue is deep.",
    fix: "Reduce primary work first: pause the sync, move it to a secondary source, shed noncritical reads, and wait for headroom. Adding a reader is not a latency fix for a write-bound primary.",
    checkFirst: [
      "Compare primary p99 with sync progress and operation rate.",
      "Check slow queries and disk latency on the primary.",
      "Check whether write concern is waiting on lagging secondaries.",
    ],
  },
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 6,
    crit: 10,
    title: "Replication lag is growing during initial sync",
    cause: "The new member is still copying data and building indexes, so it is not applying the live oplog at full speed. A longer sync widens the gap and increases the risk of falling off the oplog.",
    fix: "Stop routing reads to the new member. A different sync source changes who pays the read cost, not how long the new member is behind. Confirm the oplog window covers the sync; if the gap keeps growing, remove the member and retry during lower load.",
    checkFirst: [
      "Check `rs.printSecondaryReplicationInfo()` and the oplog window.",
      "Check initial sync progress and the sync source.",
      "Check write rate and whether the primary is applying flow control.",
    ],
  },
  {
    id: "sync-source-cpu",
    metricId: "sync-source-cpu",
    warn: 70,
    crit: 85,
    title: "The secondary sync source is overloaded",
    cause: "The selected secondary is serving initial sync reads on top of replication writes. Moving sync off the primary can move the bottleneck to the new source.",
    fix: "Choose a different source with CPU, disk, and lag headroom, wait for lower load, or accept a longer sync. Check the source before moving primary load onto it.",
    checkFirst: [
      "Check CPU and disk I/O on the selected source.",
      "Check the source's replication lag and cache behavior.",
      "Check whether the source is already serving production reads.",
    ],
  },
  {
    id: "new-secondary-p99",
    metricId: "new-secondary-p99",
    warn: 50,
    crit: 100,
    title: "Reads are hitting a cold secondary",
    cause: "The new member has a cold WiredTiger cache. Serving reads before it warms turns memory hits into disk reads and raises latency even when CPU looks idle.",
    fix: "Do not route production reads until sync completes. Warm the member with a small, capped read share, watch disk I/O and cache hit ratio, then increase traffic gradually.",
    checkFirst: [
      "Check sync state: the member must be SECONDARY, not STARTUP2.",
      "Check cache hit ratio and disk read latency on the new member.",
      "Check read preference and whether the router can select the new member.",
    ],
  },
  {
    id: "new-secondary-cpu",
    metricId: "new-secondary-cpu",
    warn: 75,
    crit: 90,
    title: "The new secondary is overloaded by reads",
    cause: "Read offload can move a read bottleneck onto the new member, especially before its cache warms or when one member receives a large share of routed reads.",
    fix: "Reduce the read share, spread reads across more eligible members, or warm the cache before increasing traffic. A new secondary is not unlimited read capacity.",
    checkFirst: [
      "Check per-member CPU and disk I/O on the new secondary.",
      "Check whether read routing sends all traffic to one member.",
      "Check whether the working set fits in the WiredTiger cache.",
    ],
  },
];

export const addingReadersModel: SimModel = {
  id: "mongodb-adding-readers",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const state = initialSyncState(p);
    const values = compute(p, state);
    const frame = buildFrame(seed, state, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const state = readSyncState(frame, p);
    const values = compute(p, state);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(seed, state, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    const jitter = rng.between(-0.4, 0.4) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "primary-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    const p99 = next.metrics.find((item) => item.id === "primary-p99")?.value ?? values.primaryP99;
    next.summary = `${formatCpu(values.primaryCpu)} primary CPU · p99 ${p99.toFixed(0)}ms · lag ${formatLag(values.replicaLag)} · sync ${values.syncProgress.toFixed(0)}%`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    recordSeries(next, "cpu.primary", values.primaryCpu);
    for (const node of next.nodes.filter((item) => item.id.startsWith("new-replica-"))) {
      recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? (node.utilization ?? 0) * 100));
    }

    const previousCount = Math.round(Number(frame.flags.activeSecondaries ?? 0));
    const previousSource = Math.round(Number(frame.flags.syncSource ?? 0));
    const changed = state.active !== previousCount;
    const sourceChanged = state.active > 0 && !changed && state.source !== previousSource;
    next.flags = {
      ...frame.flags,
      seed,
      activeSecondaries: state.active,
      syncStartedAt: state.startedAt,
      syncDoneAt: state.doneAt,
      syncComplete: state.complete ? 1 : 0,
      warmStartedAt: state.warmStartedAt,
      syncSource: state.source,
      syncAnnounced: changed || sourceChanged ? 0 : Number(frame.flags.syncAnnounced ?? 0),
      syncCompleteEvent: changed || sourceChanged ? 0 : Number(frame.flags.syncCompleteEvent ?? 0),
      coldReadAnnounced: changed || sourceChanged ? 0 : Number(frame.flags.coldReadAnnounced ?? 0),
      paramsKey: key,
    };
    if (resetSeries) seedSeries(next, values, seed);

    if (changed && state.active > 0) {
      pushEvent(next, {
        id: "secondaries-added",
        at: frame.t,
        severity: "info",
        title: "New secondary added",
        detail: `${state.active} member${state.active === 1 ? "" : "s"} added. Initial sync starts from ${state.source === 1 ? "Secondary A" : "the primary"}; the member cannot serve reads until sync completes.`,
      });
    }
    if (sourceChanged) {
      pushEvent(next, {
        id: "sync-source-changed",
        at: frame.t,
        severity: "warn",
        title: "Sync source changed and initial sync restarted",
        detail: "`initialSyncSourceReadPreference` is a `mongod` startup setting. In production, changing it requires restarting the new member's sync attempt, so progress starts over.",
      });
    }
    if (state.active > 0 && Number(next.flags.syncAnnounced ?? 0) !== 1) {
      pushEvent(next, {
        id: "initial-sync-started",
        at: frame.t,
        severity: "warn",
        title: "Initial sync started",
        detail: "The new member is copying the data set and building indexes. This adds read and network work to the sync source before it adds any read capacity.",
      });
      next.flags.syncAnnounced = 1;
    }
    if (state.complete && Number(next.flags.syncCompleteEvent ?? 0) !== 1) {
      pushEvent(next, {
        id: "initial-sync-complete",
        at: frame.t,
        severity: "info",
        title: "Initial sync complete",
        detail: "The member has reached SECONDARY. It can serve reads now, but its cache is still cold and reads may hit disk.",
      });
      next.flags.syncCompleteEvent = 1;
    }
    if (state.complete && num(p, "readOffload", 0) > 0 && Number(next.flags.coldReadAnnounced ?? 0) !== 1) {
      pushEvent(next, {
        id: "cold-reads-routed",
        at: frame.t,
        severity: "warn",
        title: "Reads routed to a cold secondary",
        detail: `The new member is serving ${Math.round(values.effectiveOffload * 100)}% of reads with a cold cache. Watch p99 and disk I/O, not just CPU.`,
      });
      next.flags.coldReadAnnounced = 1;
    }

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const state = readSyncState(frame, p);
    const values = compute(p, state);
    const items: string[] = [];
    if (state.active > 0 && !state.complete) {
      items.push(
        `Initial sync is ${values.syncProgress.toFixed(0)}% complete. The new member is in STARTUP2 and cannot serve reads, so ${state.source === 1 ? "Secondary A" : "the primary"} is paying the sync cost without receiving any read relief.`,
      );
      items.push(
        state.source === 1
          ? `Secondary A is the sync source at ${formatCpu(values.sourceCpu)} CPU. Moving sync off the primary moved the read cost, not the time the new member spends behind.`
          : "The primary is the sync source. Choosing an eligible secondary with headroom would move the sync reads off the primary, but it would not shorten the new member's catch-up.",
      );
    } else if (state.active > 0 && state.complete) {
      items.push(
        `Initial sync is complete. The new member can serve reads, but cache warmth is ${(state.warm * 100).toFixed(0)}%, so cold reads can still hit disk.`,
      );
    } else {
      items.push("No new member is syncing. The primary is carrying the current write load and any reads not routed to existing secondaries.");
    }
    if (values.primaryCpu >= 85) {
      const cause =
        state.active > 0
          ? state.complete
            ? "Production load plus replication to the new members is above the illustrative capacity."
            : "Sync overhead and replication traffic are competing with production."
          : "Production load is above the illustrative capacity.";
      items.push(`Primary work is ${Math.round(values.primaryCpu)}% of the illustrative capacity. ${cause}`);
    } else {
      items.push(
        `Primary CPU is ${formatCpu(values.primaryCpu)} against an illustrative ${PRIMARY_CAPACITY.toLocaleString()} ops/s capacity.`,
      );
    }
    if (values.replicaLag >= 6) {
      items.push(
        `Replication lag is ${formatLag(values.replicaLag)}. A longer sync keeps the new member further behind and raises the risk of falling off the oplog.`,
      );
    }
    if (values.effectiveOffload > 0) {
      items.push(
        `${Math.round(values.effectiveOffload * 100)}% of reads are effectively routed to the new member; its p99 is ${values.newP99.toFixed(0)}ms.`,
      );
    } else {
      items.push("No reads are effectively routed to the new member yet; it cannot serve them until sync completes. Adding a reader is currently a write-path cost, not a read-path benefit.");
    }
    items.push(
      `The primary sees ${Math.round(values.writeRps).toLocaleString()} writes/s and ${Math.round(values.readRps).toLocaleString()} reads/s. Adding a secondary does not reduce the write rate.`,
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
    description: "A stable three-member set at 12k ops/s. The primary has headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "16k ops/s with a 10% write share. The primary is busy but below critical.",
    tone: "warn",
    params: defaults({ requestRate: 16_000, writeShare: 10 }),
  },
  {
    id: "failure",
    label: "Add two readers",
    description: "Two new secondaries start initial sync during peak traffic.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, writeShare: 25, newSecondaries: 2, readOffload: 0, syncSource: 0 }),
  },
  {
    id: "secondary-source",
    label: "Secondary sync source",
    description: "Move initial sync reads to Secondary A. Primary CPU falls; the source secondary and lag become the constraint.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, writeShare: 25, newSecondaries: 2, readOffload: 0, syncSource: 1 }),
  },
  {
    id: "route-reads",
    label: "Route reads after sync",
    description: "Add one member, then route half the reads after it syncs. Primary CPU falls; cold reads raise p99.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, writeShare: 25, newSecondaries: 1, readOffload: 50, syncSource: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "No new member during the incident. Lower load and add the reader in a quiet window.",
    tone: "ok",
    params: defaults({ requestRate: 10_000, writeShare: 15, newSecondaries: 0, readOffload: 0, syncSource: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-add-reader",
  title: "Predict what a new secondary does to the primary",
  simId: "adding-readers",
  question:
    "The primary is already busy. You add two secondaries and route no reads yet. What happens to the primary in the next 30 seconds?",
  prediction: {
    options: [
      { id: "improves", label: "Primary CPU falls because there are now two more members" },
      { id: "worse", label: "Primary CPU rises and replication lag grows while both sync" },
      { id: "neutral", label: "The primary is unchanged; only the new members are busy" },
      { id: "reads", label: "Read latency improves immediately as the new members serve traffic" },
    ],
    correctOptionId: "worse",
    explanation:
      "A new member must finish initial sync before it can serve reads. During sync it copies data and builds indexes from a source member, and the primary also replicates to more members. The primary pays that cost first; read relief can only come later.",
  },
  setup: defaults({ requestRate: 12_000, writeShare: 25, newSecondaries: 2, readOffload: 0, syncSource: 0 }),
  runFor: 30,
  observe: [
    "Primary CPU rises from about 70% to critical as initial sync ramps up.",
    "Replication lag grows because the new members are copying data and building indexes.",
    "Initial sync progress is still below 100%; neither new member can serve reads.",
    "Primary p99 rises with queueing, so the incident gets worse before it gets better.",
  ],
  explain:
    "Adding a secondary is a replication event before it is a read-scaling event. The new member needs a full copy and index build, then it must catch up on the oplog and warm its cache. If the primary is the constraint, the first move is to reduce primary work or point the sync at a secondary with headroom, not to add another consumer of the primary.",
  fix: defaults({ requestRate: 8_000, writeShare: 20, newSecondaries: 1, readOffload: 0, syncSource: 1 }),
  debrief:
    "The safe path is to lower traffic, add one member as non-voting and low priority, choose a secondary sync source with headroom through `initialSyncSourceReadPreference`, and leave reads on the primary until the member reaches SECONDARY and its cache is warm. That takes longer, but it does not turn a read incident into a primary write outage. After sync, warm the member with a small read share and increase it only if p99 and lag stay inside budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB replica set has one primary that accepts writes and, by default, reads. Secondaries apply the primary's operation log (oplog) asynchronously. Adding a member does not give it a copy of the data immediately: it performs an initial sync, copying the data set from a sync source and building indexes before it reaches SECONDARY. Until then it is in STARTUP2 and cannot serve application reads.",
  },
  {
    type: "p",
    text: "That makes a new secondary a write-path and replication event before it is a read-path improvement. The new member consumes CPU, disk, and network on the sync source, and the primary also replicates to one more member. If the primary is already saturated, those costs arrive before any read relief. After sync, the member still has a cold WiredTiger storage-engine cache, so the first reads can hit disk even when CPU is low.",
  },
  { type: "h2", text: "Where it sits" },
  { type: "diagram", id: "replica-lag", caption: "The primary serves writes and default reads, replicates to existing secondaries, and supplies a new member during initial sync." },
  {
    type: "p",
    text: "The client connects through a MongoDB driver. With read preference primary, all reads go to the primary. A secondary read preference can use an eligible secondary, but only after that member is in SECONDARY state and within any staleness limit. `rs.add()` updates the replica set configuration; the new member then selects a sync source. The source is often the primary, but it can be another eligible secondary depending on `initialSyncSourceReadPreference`, a `mongod` startup parameter.",
  },
  {
    type: "p",
    text: "This module models a replica set with one primary, two existing secondaries, and up to two new members. The capacity, latency curve, and lag thresholds are illustrative teaching values, not MongoDB limits. The shape is the lesson: sync load lands first, read capacity arrives later, and the cache is cold when it does.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Primary CPU and 99th-percentile latency (p99): the cost of serving production plus initial sync.",
      "Replication lag: how far the new member is from the primary's latest oplog entry.",
      "Initial sync progress: the member is not readable until it reaches SECONDARY.",
      "New secondary p99 and CPU: the cold-cache penalty after sync completes.",
      "Effective read offload: reads routed to new members only count after they are eligible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Add two readers. Watch the first 30 seconds: primary CPU and lag rise while sync progress is incomplete. Compare Secondary sync source, then Route reads after sync. Use the experiment to predict the primary effect before you reveal the explanation.",
  },
  {
    type: "table",
    headers: ["Action", "What it fixes", "What it costs"],
    rows: [
      ["Add a secondary", "Adds read capacity after sync and cache warmup", "Initial sync load on the source, more replication traffic, cold reads at first"],
      ["Choose a secondary sync source", "Moves initial sync reads off the primary (`initialSyncSourceReadPreference`)", "Loads that secondary; lag still grows until sync completes"],
      ["Use file copy based initial sync", "`initialSyncMethod=fileCopyBased`; MongoDB Enterprise only, can shorten the copy", "Still reads the source; not available on every deployment"],
      ["External network/IO limit", "Caps sync bandwidth without a MongoDB setting", "Longer sync and lag; outside the database"],
      ["Route reads after sync", "Moves read work off the primary", "Stale reads within the lag budget; cold-cache latency"],
      ["Add a non-voting member first", "Avoids changing election quorum while it syncs", "Another configuration step before it can vote"],
    ],
  },
  {
    type: "p",
    text: "The first question is whether the primary is read-bound or write-bound. A secondary can only help with reads. If writes are the constraint, adding a member adds replication work and does not reduce the write rate. If reads are the constraint and the product tolerates bounded staleness, add the member during low traffic, choose a secondary sync source with headroom through `initialSyncSourceReadPreference`, and route reads only after it is caught up and warm. `initialSyncMethod=fileCopyBased` is an Enterprise-only option that can shorten the copy, but it still consumes source I/O; external network or disk limits can slow the sync without any MongoDB percentage throttle.",
  },
  { type: "sim", simId: "adding-readers" },
  { type: "experiment", experimentId: "predict-add-reader" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Initial sync ramped up and the primary's CPU crossed the critical threshold. The new members were copying data and building indexes, so they could not serve reads. Replication lag grew because the new members were not applying the live oplog at full speed. Primary p99 rose with queueing. The incident got worse before any read capacity arrived.",
  },
  {
    type: "p",
    text: "Choosing Secondary A as the sync source lowered primary CPU but raised that secondary's CPU, and replication lag still grew until the new members caught up. Routing reads after sync moved work off the primary, but the new member's cold cache raised p99 until it warmed. The recovery path was to stop adding members during the incident, lower traffic, then add one member with a secondary sync source and no read routing until it was healthy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`rs.status()`: member state, health, and `initialSyncStatus` where available. A member in STARTUP2 is not serving reads.",
      "`initialSyncSourceReadPreference` and `initialSyncMethod` settings: which source and sync method the new member is using.",
      "`rs.printSecondaryReplicationInfo()`: lag per secondary. Use `rs.printReplicationInfo()` for the primary's oplog window.",
      "`db.serverStatus()`: opcounters, connections, WiredTiger cache metrics, and disk I/O on the primary and the new member.",
      "`mongod` logs: initial sync start and completion, sync source selection, and transition to SECONDARY.",
      "Driver and server metrics: read preference errors, server selection timeouts, and read latency by member.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the primary is read-bound or write-bound, then check initial sync progress, the selected sync source, and that source's CPU and lag. If the primary is saturated and the new member is still syncing, stop routing reads and reduce primary work. Do not add another reader to fix a write-path problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the bottleneck: compare primary CPU, p99, opcounters, and disk I/O before changing topology.",
      "Stop routing reads to the new member if it is still syncing or cold; it cannot help yet.",
      "Pick a sync source with headroom: `initialSyncSourceReadPreference` can prefer a secondary, but check that source's CPU, disk, and lag first.",
      "Wait for a low-traffic window. If `initialSyncMethod=fileCopyBased` is available, use it to shorten the copy, but account for source I/O.",
      "Add the member as non-voting and low priority, then promote it after it reaches SECONDARY and stays caught up.",
      "Warm the member with a small read share and watch p99, disk I/O, and cache hit ratio before increasing traffic.",
      "Verify the primary, source, lag, and new member together at peak; remove the member if the source cannot absorb the sync.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Adding a secondary buys read capacity only after sync and warmup; the primary or another source pays the cost first.",
      "A secondary sync source protects the primary but loads that secondary; if the source is already lagging, freshness can get worse.",
      "`initialSyncMethod=fileCopyBased` is Enterprise-only; it can shorten the copy but still consumes source I/O.",
      "External network or disk limits can reduce peak sync load, but they extend the sync window and the time the member is behind.",
      "A non-voting member avoids changing election quorum, but it is another step before the member can vote.",
      "Routing reads to a cold secondary lowers primary CPU but can raise p99 and disk I/O until the cache warms.",
      "If the workload is write-bound, no secondary fixes it; reduce write load, improve the write path, or scale the primary.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-worse",
    question:
      "The primary is at 90% CPU and p99 is rising. A teammate adds a secondary and routes 30% of reads to it. Why might latency get worse before it gets better?",
    difficulty: 3,
    hints: [
      "The new member is not eligible to serve reads immediately.",
      "Initial sync has a source and a cost.",
      "A cold cache turns memory reads into disk reads.",
    ],
    answer:
      "The new member must complete initial sync before it can serve reads, so the 30% routing does not take effect immediately. During sync it copies the data set and builds indexes from a source member, which is often the primary, and the primary also replicates to one more member. That adds CPU, disk, and network work to an already saturated primary. After sync, the member reaches SECONDARY but its WiredTiger cache is cold, so the first reads can hit disk and raise p99 even if CPU looks low. The safe sequence is to reduce primary work, choose a secondary sync source with headroom through `initialSyncSourceReadPreference`, wait for SECONDARY and warmup, then route reads gradually.",
    followUps: [
      "What would you check first to prove the sync is the cause?",
      "How does the sync source choice change the blast radius?",
      "When would you remove the new member instead of waiting?",
    ],
    redFlags: [
      "Assumes a new secondary serves reads immediately.",
      "Ignores the sync source and replication traffic.",
      "Calls low CPU on the new member proof that reads are fast.",
    ],
    rubric: [
      "Names initial sync and its source cost.",
      "Explains STARTUP2 and read eligibility.",
      "Names cold cache and disk reads.",
      "Gives an ordered mitigation.",
    ],
  },
  {
    id: "add-without-outage",
    question:
      "How do you add a secondary during a traffic peak without turning the read incident into a primary outage?",
    difficulty: 4,
    hints: [
      "Change the timing and the rate before changing the topology.",
      "A member can sync without voting.",
      "Read routing is a separate decision from adding the member.",
    ],
    answer:
      "I would avoid adding it at peak if the primary is already saturated. If it must be added, I would add it as a non-voting, low-priority member, choose a secondary sync source with CPU, disk, and lag headroom through `initialSyncSourceReadPreference`, or wait for a low-traffic window. If `initialSyncMethod=fileCopyBased` is available, I would consider it to shorten the copy, but I would still watch source I/O. I would watch primary CPU, the source's CPU, disk I/O, sync progress, and replication lag, and keep production reads on the primary until the member reaches SECONDARY. If the source starts queueing, I would pause or remove the member and retry in a quieter window. After sync, I would warm the cache with a small read share before increasing traffic.",
    followUps: [
      "What does a non-voting member change?",
      "How do you decide when to abort the sync?",
      "What does the oplog window have to cover?",
    ],
    redFlags: [
      "Starts a sync at peak without a source-capacity plan or abort plan.",
      "Routes reads before the member is eligible.",
      "Changes votes and priority in one step without checking health.",
    ],
    rubric: [
      "Separates timing, topology, and routing.",
      "Names non-voting/low-priority, sync source, and low-traffic timing.",
      "Watches primary, source, and lag.",
      "Has an abort and warmup plan.",
    ],
  },
  {
    id: "ready-for-reads",
    question:
      "What signals tell you a new secondary is ready to take production reads?",
    difficulty: 3,
    hints: [
      "State is necessary but not sufficient.",
      "Lag is a freshness budget.",
      "Cache warmth shows up in disk reads and p99.",
    ],
    answer:
      "First, the member must be in SECONDARY state, not STARTUP2 or RECOVERING, and `rs.status()` should show it healthy. Second, its replication lag must be inside the product's freshness budget, with enough oplog window to cover normal variance. Third, the cache should be warm enough that disk reads and p99 are near the existing secondaries. I would prove that with a small canary read share, then increase gradually while watching p99, disk I/O, cache hit ratio, and lag. A member that is caught up but cold is eligible, not necessarily ready for the full read load.",
    followUps: [
      "How would you measure cache warmth?",
      "What lag budget would you set for a dashboard read?",
      "What would make you send reads back to the primary?",
    ],
    redFlags: [
      "Treats SECONDARY state as the only readiness check.",
      "Ignores freshness and cache warmth.",
      "Sends all reads at once after sync.",
    ],
    rubric: [
      "Checks state and lag.",
      "Checks cache and disk behavior.",
      "Ramps reads gradually.",
      "Defines a fallback.",
    ],
  },
  {
    id: "reader-or-load",
    question:
      "When is adding a secondary the wrong response to an overloaded primary?",
    difficulty: 4,
    hints: [
      "Look at the read/write mix.",
      "A secondary does not reduce the primary's write rate.",
      "Replication itself is work.",
    ],
    answer:
      "It is the wrong response when the primary is write-bound, when the bottleneck is a single hot document or lock, or when the primary cannot absorb the extra sync and replication work. A secondary only serves reads; it does not reduce the primary's write rate, and adding it increases replication traffic. I would check opcounters, write concern, lock and query latency, and disk I/O. If writes dominate, I would reduce write load, fix the hot path, or scale the primary instead. If reads dominate and staleness is acceptable, a secondary can help after sync and warmup.",
    followUps: [
      "What if the workload is 90% reads but the primary is disk-bound?",
      "How does write concern interact with adding a member?",
      "What would you do instead of adding a reader?",
    ],
    redFlags: [
      "Adds readers for every overload.",
      "Ignores the read/write mix.",
      "Forgets that replication adds work.",
    ],
    rubric: [
      "Distinguishes read-bound from write-bound.",
      "Names replication cost.",
      "Checks write concern and hot paths.",
      "Offers an alternative.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show primary CPU, p99, disk I/O, replication lag, and oplog window per member.",
      "The read/write mix and the product's freshness budget are written down.",
      "The sync source is chosen deliberately (`initialSyncSourceReadPreference`) and has CPU, disk, and lag headroom.",
      "The team knows whether `initialSyncMethod=fileCopyBased` is available; file copy based sync is Enterprise-only.",
      "A low-traffic window is reserved for adding members.",
      "The team knows how to add a non-voting, low-priority member and promote it later.",
      "Read preference and max staleness are configured per read path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the primary is read-bound or write-bound before changing topology.",
      "Check initial sync progress and the sync source.",
      "Keep production reads off a member that is syncing or cold.",
      "Watch primary CPU, p99, lag, and the oplog window together.",
      "Record the decision to add, change the sync source, pause, or remove the member.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the member reached SECONDARY and stayed caught up at peak.",
      "Warm the cache with a capped read share before increasing traffic.",
      "Restore votes and priority only after the member is healthy.",
      "Review whether adding a reader addressed the real bottleneck.",
    ],
  },
];

const references = [
  {
    title: "Replica Set Data Synchronization",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-sync/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Initial sync phases, sync source selection, `initialSyncMethod`, and the oplog window.",
  },
  {
    title: "Add Members to a Self-Managed Replica Set",
    url: "https://www.mongodb.com/docs/manual/tutorial/expand-replica-set/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Adding a member, non-voting members, and promoting after sync.",
  },
  {
    title: "Read Preference",
    url: "https://www.mongodb.com/docs/manual/core/read-preference/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Primary and secondary read modes, staleness, and eligibility.",
  },
  {
    title: "Production Notes",
    url: "https://www.mongodb.com/docs/manual/administration/production-notes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Deployment and operational guidance for self-managed replica sets.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "adding-readers": {
      model: addingReadersModel,
      presets,
      instructions:
        "Start healthy, apply Add two readers, then watch primary CPU, lag, and sync progress for 30 seconds. Compare primary vs secondary sync source, then routing reads after sync.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Primary and source capacity, sync duration, and lag thresholds are teaching values, not MongoDB limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mongodb-read-preference",
    "mongodb-write-concern",
    "mongodb-cold-secondary",
    "mongodb-replication-lag",
  ],
};
