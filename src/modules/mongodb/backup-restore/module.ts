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

const BASE_RESTORE_MINUTES = 40;
const CONFIG_RESTORE_MINUTES = 20;

const params: ParamSpec[] = [
  {
    id: "shardCount",
    label: "Shards in the cluster",
    min: 2,
    max: 5,
    step: 1,
    value: 4,
    unit: "",
    group: "Cluster",
    help: "Each shard holds a subset of the data. A backup is not complete unless every shard and the config server metadata are included at the same cluster time.",
    format: "count",
  },
  {
    id: "snapshotSkew",
    label: "Snapshot skew",
    min: 0,
    max: 120,
    step: 1,
    value: 0,
    unit: " min",
    group: "Backup",
    help: "How far apart the shard snapshots were taken. Zero means one coordinated cluster time; larger values mean different shards reflect different moments.",
    format: "number",
  },
  {
    id: "restoreScope",
    label: "Restore scope",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Restore",
    help: "0 = one shard only, 1 = all shards without config servers, 2 = all shards and config server metadata. The scope determines whether the result is a cluster or a fragment.",
    format: "count",
  },
  {
    id: "parallelism",
    label: "Restore parallelism",
    min: 1,
    max: 8,
    step: 1,
    value: 2,
    unit: " shards",
    group: "Restore",
    help: "How many shards restore at once. More parallelism shortens the window but consumes shared network, disk, and verification capacity.",
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

interface Computed {
  shards: number;
  skew: number;
  scope: number;
  parallelism: number;
  restoredShards: number;
  configRestored: boolean;
  missingShards: number;
  skewMismatch: number;
  failedChecks: number;
  consistencyErrors: number;
  metadataMismatch: number;
  rpoSpread: number;
  restoreTimeMin: number;
  progress: number;
}

function compute(p: Params, t: number): Computed {
  const shards = Math.round(clamp(num(p, "shardCount", 4), 2, 8));
  const skew = clamp(num(p, "snapshotSkew", 0), 0, 120);
  const scope = Math.round(clamp(num(p, "restoreScope", 2), 0, 2));
  const parallelism = Math.round(clamp(num(p, "parallelism", 2), 1, 8));
  const restoredShards = scope >= 1 ? shards : 1;
  const configRestored = scope === 2;
  const missingShards = shards - restoredShards;
  const skewMismatch = skew > 5 ? Math.min(shards, Math.max(1, Math.ceil(skew / 15))) : 0;
  const failedChecks = missingShards + (configRestored ? 0 : 1) + skewMismatch;
  const consistencyErrors = failedChecks * 12;
  const metadataMismatch = configRestored
    ? clamp(skewMismatch * 8, 0, 100)
    : clamp(55 + missingShards * 5, 0, 100);
  const rpoSpread = skew + (configRestored ? 0 : 30);
  const restoreTimeMin =
    (shards * 20 +
      BASE_RESTORE_MINUTES +
      (configRestored ? CONFIG_RESTORE_MINUTES : 0) +
      skew * 0.5) /
      parallelism +
    15;
  const restoreDurationSeconds = restoreTimeMin * 1.2;

  return {
    shards,
    skew,
    scope,
    parallelism,
    restoredShards,
    configRestored,
    missingShards,
    skewMismatch,
    failedChecks,
    consistencyErrors,
    metadataMismatch,
    rpoSpread,
    restoreTimeMin,
    progress: clamp(t / restoreDurationSeconds),
  };
}

function health(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const verifierHealth = health(
    Math.max(values.consistencyErrors, values.metadataMismatch, values.rpoSpread),
    1,
    20,
  );
  const nodes: SimNode[] = [
    {
      id: "backup",
      label: "Backup set",
      kind: "storage",
      health: values.skew > 5 ? "warn" : "ok",
      sublabel: `${values.shards} shard snapshots · ${values.skew.toFixed(0)} min skew`,
      detail:
        "A sharded-cluster backup is a set: every shard, the config server metadata, and one cluster time. A snapshot of one shard is a valid shard backup but not a valid cluster backup.",
      meta: { view: "flow" },
    },
  ];

  for (let index = 1; index <= values.shards; index++) {
    const restored = index <= values.restoredShards;
    nodes.push({
      id: `shard-${index}`,
      label: `Shard ${index}`,
      kind: "db",
      role: "shard",
      health: restored ? (values.skew > 5 ? "warn" : "ok") : "down",
      utilization: restored ? values.progress : 0,
      sublabel: restored
        ? `restored · ${(values.restoreTimeMin / values.parallelism).toFixed(0)} min`
        : "not in restore scope",
      detail:
        "A shard restore brings back only the chunks stored on that shard. Cross-shard documents and routing metadata come from the rest of the cluster state.",
      meta: { view: "flow" },
    });
  }

  nodes.push({
    id: "config",
    label: "Config servers",
    kind: "db",
    role: "instance",
    health: values.configRestored ? (values.skew > 5 ? "warn" : "ok") : "down",
    utilization: values.configRestored ? values.progress : 0,
    sublabel: values.configRestored ? "routing metadata restored" : "metadata missing",
    detail:
      "Config servers hold the cluster's routing table, chunk ranges, and shard identity. Restoring shards without matching config metadata leaves a cluster that does not know where its data belongs.",
    meta: { view: "flow" },
  });

  nodes.push({
    id: "verifier",
    label: "Consistency check",
    kind: "service",
    role: "instance",
    health: verifierHealth,
    sublabel:
      values.consistencyErrors === 0
        ? "routing and cross-shard checks pass"
        : `${values.consistencyErrors} failed checks · ${values.metadataMismatch.toFixed(0)}% metadata mismatch`,
    detail:
      "A restore is not done when files are copied. Verify chunk metadata, orphaned documents, duplicate keys across shards, and a known cross-shard transaction.",
    meta: { view: "flow" },
  });

  const edges = [
    ...Array.from({ length: values.shards }, (_, index) =>
      edge(
        `backup-shard-${index + 1}`,
        "backup",
        `shard-${index + 1}`,
        values.progress,
        index + 1 <= values.restoredShards ? "ok" : "crit",
      ),
    ),
    edge(
      "backup-config",
      "backup",
      "config",
      values.progress,
      values.configRestored ? "ok" : "crit",
    ),
    edge("config-verifier", "config", "verifier", values.progress, verifierHealth),
  ];

  const state =
    values.consistencyErrors > 0
      ? "cluster inconsistent"
      : values.progress >= 1
        ? "restore verified"
        : "restore in progress";
  const summary = `${state} · ${values.restoredShards}/${values.shards} shards · ${values.consistencyErrors} consistency errors · RPO spread ${values.rpoSpread.toFixed(0)} min`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric(
        "consistency-errors",
        "Consistency errors",
        values.consistencyErrors,
        "",
        1,
        20,
        "count",
      ),
      metric(
        "metadata-mismatch",
        "Metadata mismatch",
        values.metadataMismatch,
        "%",
        2,
        20,
        "percent",
      ),
      metric("rpo-spread", "Recovery point spread", values.rpoSpread, " min", 5, 15, "number"),
      metric(
        "restore-time",
        "Estimated restore time",
        values.restoreTimeMin,
        " min",
        180,
        300,
        "number",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      scope: values.scope,
      restoredShards: values.restoredShards,
      consistencyErrors: values.consistencyErrors,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 6)) / 2.2);
  const rows: [string, number, number][] = [
    ["consistency-errors", values.consistencyErrors, 0.1],
    ["metadata-mismatch", values.metadataMismatch, 0.2],
    ["rpo-spread", values.rpoSpread, 0.05],
    ["restore-time", values.restoreTimeMin, 0.3],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "consistency-errors",
    metricId: "consistency-errors",
    warn: 1,
    crit: 20,
    title: "The restored cluster fails consistency checks",
    cause:
      "The restore did not include every shard and the config server metadata at one cluster time. Missing shards leave chunks without owners; missing metadata leaves routing entries that point at the old cluster.",
    fix: "Restore all shards and the config servers from a coordinated backup set. If the backup itself has skew, choose a cluster-consistent point and accept the recovery point that goes with it.",
    checkFirst: [
      "Check whether every shard and the config servers are in the restore scope.",
      "Check the backup timestamps for each shard and the config server.",
      "Check chunk metadata for ranges whose shard no longer exists.",
    ],
  },
  {
    id: "metadata-mismatch",
    metricId: "metadata-mismatch",
    warn: 2,
    crit: 20,
    title: "Routing metadata does not match the restored shards",
    cause:
      "Config servers store the chunk-to-shard mapping, shard identity, and routing history. Restoring shards from a different time than the config servers leaves queries pointed at chunks that moved or no longer exist.",
    fix: "Restore the config server replica set from the same coordinated point as the shards, then verify the routing table before opening the cluster to application traffic.",
    checkFirst: [
      "Check `config.chunks` and `config.shards` against the restored shard list.",
      "Check for orphaned documents and chunks with no owning shard.",
      "Check the config server backup timestamp against the shard backups.",
    ],
  },
  {
    id: "rpo-spread",
    metricId: "rpo-spread",
    warn: 5,
    crit: 15,
    title: "The recovery point is spread across time",
    cause:
      "Snapshots or dumps taken at different times cannot describe one cluster state. Restoring them together either loses writes that happened after the earliest snapshot or creates cross-shard inconsistencies.",
    fix: "Take a coordinated backup at one cluster time, or quiesce writes and stop the balancer for the snapshot window. Record the chosen recovery point and test it.",
    checkFirst: [
      "Check the timestamp of every shard and config backup.",
      "Check whether the balancer was stopped during the backup.",
      "Check whether application writes continued during the snapshot window.",
    ],
  },
  {
    id: "restore-time",
    metricId: "restore-time",
    warn: 150,
    crit: 300,
    title: "The restore is taking longer than the recovery objective",
    cause:
      "Restoring many shards with limited parallelism extends the window. Parallelism uses shared network and disk bandwidth, so adding workers helps only until the recovery host saturates.",
    fix: "Measure restore throughput on the actual backup size, pre-stage the restore host, and set parallelism from the bottleneck resource. Do not trade consistency for speed.",
    checkFirst: [
      "Check restore throughput per shard and the bottleneck on the restore host.",
      "Check whether all shards are competing for the same network or disk.",
      "Check whether verification is running at the same time as the restore.",
    ],
  },
];

export const backupRestoreModel: SimModel = {
  id: "mongodb-backup-restore",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.1, 0.1) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "restore-time" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (!Number(next.flags.restoreAnnounced ?? 0)) {
      pushEvent(next, {
        id: "restore-started",
        at: frame.t,
        severity: "info",
        title: "Restore started",
        detail: `Scope: ${values.scope === 0 ? "one shard" : values.scope === 1 ? "all shards without config servers" : "all shards and config servers"}.`,
        nodeId: "backup",
      });
      next.flags.restoreAnnounced = 1;
    }
    if (values.consistencyErrors >= 20 && !Number(next.flags.inconsistentAnnounced ?? 0)) {
      pushEvent(next, {
        id: "restore-inconsistent",
        at: frame.t,
        severity: "crit",
        title: "Restored cluster is inconsistent",
        detail: `${values.consistencyErrors} modeled consistency checks failed. The restore is missing part of the cluster state, not just waiting for the remaining shards.`,
        nodeId: "verifier",
        metricId: "consistency-errors",
      });
      next.flags.inconsistentAnnounced = 1;
    }
    if (
      values.consistencyErrors === 0 &&
      values.progress >= 1 &&
      !Number(next.flags.verifiedAnnounced ?? 0)
    ) {
      pushEvent(next, {
        id: "restore-verified",
        at: frame.t,
        severity: "info",
        title: "Restore verified",
        detail:
          "All shards and config metadata were restored from a coordinated point and the consistency check passed.",
        nodeId: "verifier",
      });
      next.flags.verifiedAnnounced = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    if (values.scope === 0) {
      items.push(
        `Only ${values.restoredShards} of ${values.shards} shards is in scope. The other ${values.missingShards} shards and the config server metadata are still missing, so the result is not a cluster restore.`,
      );
    } else if (!values.configRestored) {
      items.push(
        "All shards are restored, but the config servers are not. The cluster has data without the routing table that says which chunk belongs where.",
      );
    } else {
      items.push(
        `All ${values.shards} shards and the config servers are in scope. The remaining risk is whether they represent one cluster time.`,
      );
    }
    if (values.skew > 5) {
      items.push(
        `Snapshot skew is ${values.skew.toFixed(0)} minutes. Restoring those snapshots together cannot produce a single cluster state; choose a common point and accept the data loss that goes with it.`,
      );
    } else {
      items.push(
        "Snapshot skew is inside the coordinated window, so the shards can be treated as one backup set.",
      );
    }
    items.push(
      `Modeled restore time is ${values.restoreTimeMin.toFixed(0)} minutes at parallelism ${values.parallelism}. This is illustrative and does not include verification or application warmup.`,
    );
    return items;
  },
  legend: [
    { label: "Verified", tone: "ok" },
    { label: "Needs review", tone: "warn" },
    { label: "Inconsistent", tone: "crit" },
    { label: "Missing", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "Four shards and the config servers restore from one coordinated snapshot with parallelism 2.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Large cluster",
    description:
      "Five shards restore with low parallelism and a small snapshot skew. Consistency is intact, but the restore window is long.",
    tone: "warn",
    params: defaults({ shardCount: 5, snapshotSkew: 4, restoreScope: 2, parallelism: 1 }),
  },
  {
    id: "failure",
    label: "One shard only",
    description:
      "One shard restores from a 30-minute-skewed snapshot while the other shards and config servers are left behind.",
    tone: "crit",
    params: defaults({ shardCount: 4, snapshotSkew: 30, restoreScope: 0, parallelism: 2 }),
  },
  {
    id: "recovery",
    label: "Coordinated restore",
    description:
      "All shards and config servers restore from one cluster time. The consistency check passes.",
    tone: "ok",
    params: defaults({ shardCount: 4, snapshotSkew: 0, restoreScope: 2, parallelism: 2 }),
  },
  {
    id: "shards-only",
    label: "Shards without config",
    description:
      "Every shard is restored, but the config servers are omitted. Data exists without matching routing metadata.",
    tone: "crit",
    params: defaults({ shardCount: 4, snapshotSkew: 0, restoreScope: 1, parallelism: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-one-shard",
  title: "Why is the cluster still inconsistent after one shard restores?",
  simId: "backup-restore",
  question:
    "A four-shard cluster loses its data. The team restores shard 1 from a 30-minute-old snapshot and leaves the other shards and config servers pending. Shard 1 reports success. Why is the cluster inconsistent?",
  prediction: {
    options: [
      {
        id: "auto",
        label: "The other shards will sync automatically from shard 1 once it is online",
      },
      {
        id: "cluster",
        label:
          "A cluster is a set of shards plus config metadata at one time; one shard is only a fragment",
      },
      {
        id: "oplog",
        label: "Replaying shard 1's oplog reconstructs the missing shards and routing table",
      },
      {
        id: "balancer",
        label: "The balancer will move the missing chunks back once the cluster starts",
      },
    ],
    correctOptionId: "cluster",
    explanation:
      "Shards do not replicate each other. Each shard holds a subset of the data, and the config servers hold the routing table that maps chunks to shards. Restoring one shard restores its local files; it does not recreate the other shards, the config metadata, or a common point in time. The balancer moves chunks within an existing cluster and cannot invent data that was never restored.",
  },
  setup: defaults({ shardCount: 4, snapshotSkew: 30, restoreScope: 0, parallelism: 2 }),
  runFor: 20,
  observe: [
    "Only shard 1 is restored; the other shards and config servers remain unavailable.",
    "Metadata mismatch is high because the routing table is missing or stale.",
    "The consistency check fails even though shard 1 itself reports a successful restore.",
    "Adding restore parallelism does not fix the missing scope.",
  ],
  explain:
    "The unit of restore is the cluster, not the node. A coordinated backup captures every shard and the config servers at one cluster time, and a coordinated restore puts them back together. Restoring one shard can be useful for a targeted recovery, but it cannot produce a consistent cluster by itself.",
  fix: defaults({ shardCount: 4, snapshotSkew: 0, restoreScope: 2, parallelism: 2 }),
  debrief:
    "Before restoring, confirm the scope: every shard, the config servers, and one recovery point. Then verify routing metadata, orphaned documents, and a cross-shard read. A restore that completes quickly but leaves the cluster inconsistent is a failed recovery, not a partial success.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB backup is a copy of data and the metadata needed to use it. In a replica set, that means the data files or a logical dump plus the oplog if you need point-in-time recovery. In a sharded cluster, it also means every shard and the config server replica set, which stores the routing table, chunk ranges, and shard identities.",
  },
  {
    type: "p",
    text: "A restore is the reverse: put the data back and make the cluster able to answer queries correctly. Copying files is the easy part. The hard part is restoring a set of components that describe one moment in time. A shard restored from Monday and config metadata restored from Tuesday are not a cluster; they are two fragments of different clusters.",
  },
  {
    type: "p",
    text: "MongoDB's backup guidance distinguishes filesystem snapshots, `mongodump` logical backups, and managed backup services. For a sharded cluster, the balancer must not move chunks during the backup window, and all components must be captured at a coordinated point. A snapshot of one shard is a valid shard backup, but it is not a cluster backup.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Applications connect through `mongos` to shards. The config servers tell `mongos` which chunk lives on which shard. If the config metadata is missing or from a different time, queries can target the wrong shard, miss documents, or fail on chunks that no longer have an owner.",
  },
  {
    type: "table",
    headers: ["Component", "What it holds", "What breaks if it is missing"],
    rows: [
      [
        "Shard",
        "A subset of collections and chunks",
        "That shard's data is gone; other shards cannot recreate it",
      ],
      [
        "Config servers",
        "Routing table, chunk ranges, shard identity",
        "`mongos` cannot route or verify chunk ownership",
      ],
      [
        "Replica set oplog",
        "Recent operations for point-in-time recovery",
        "You can restore only the snapshot time, not a later point",
      ],
      [
        "Application state",
        "Ids, queues, and external references",
        "The database is consistent but the product is not",
      ],
    ],
  },
  {
    type: "compare",
    leftTitle: "Coordinated cluster backup",
    rightTitle: "Independent node backups",
    rows: [
      {
        label: "Time",
        left: "One cluster time across shards and config",
        right: "Each node at a different time",
      },
      {
        label: "Restore",
        left: "Whole cluster returns to one point",
        right: "Fragments that may not fit together",
      },
      {
        label: "Verification",
        left: "Routing, orphans, and cross-shard reads",
        right: "Per-node file or count checks",
      },
      {
        label: "Failure mode",
        left: "Longer backup window",
        right: "Silent inconsistency after a fast restore",
      },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "Decision: what is the restore unit?",
    body: "Choose the cluster, a shard, or a single collection before the incident. A cluster restore needs every shard and the config servers from one point. A targeted shard restore can be legitimate for one tenant or one chunk range, but it must not be presented as a cluster recovery.",
  },
  {
    type: "callout",
    tone: "info",
    title: "Decision: how will you verify?",
    body: "A file count is not a consistency check. Verify `config.chunks` and `config.shards`, look for orphaned documents, run a known cross-shard query, and compare a sample of duplicate keys. Record the checks in the runbook so the next restore does not depend on memory.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Restore scope: one shard, all shards, or all shards plus config servers.",
      "Snapshot skew: how far apart the backup timestamps are.",
      "Consistency errors and metadata mismatch: whether the result is a cluster or a fragment.",
      "Recovery point spread: how much time the recovered components span.",
      "Restore time and parallelism: the cost of bringing the set back.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "How to use the demo",
    body: "Start Healthy, then apply One shard only. Watch the missing shards and config metadata fail the consistency check even though the restored shard is healthy. Set scope to all shards without config to isolate the metadata failure, then apply Coordinated restore.",
  },
  { type: "sim", simId: "backup-restore" },
  { type: "experiment", experimentId: "predict-one-shard" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The restore brought back one shard and reported success. The other shards and the config servers were still missing, so the cluster had a piece of data without the routing table that describes the whole. The consistency check failed on missing chunks and metadata, not on the shard that had just been restored.",
  },
  {
    type: "p",
    text: "A coordinated restore of all shards and the config servers from one cluster time passed the check. The difference was scope and time, not restore speed. Parallelism changed how long the window lasted, not whether the result was a cluster.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A shard restore job reports success while `mongos` cannot route queries for chunks on other shards.",
      "`config.chunks` references shards that are not in the restored topology.",
      "Orphaned documents appear on shards that should no longer own a chunk range.",
      "Cross-shard transactions or reads return partial results or duplicate keys.",
      "Restore take longer than the objective because all shards share one recovery host's bandwidth.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the restore scope before checking restore speed. Confirm every shard and the config servers are included, then compare timestamps. If the scope is complete, check routing metadata and orphans. If it is incomplete, stop and fix the scope; adding parallelism or replaying an oplog will not recreate missing cluster state.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop writes and the balancer before taking a coordinated backup, or use a snapshot mechanism that captures the set together.",
      "Record one recovery point and the timestamp of every component.",
      "Restore all shards and the config server replica set from that set.",
      "Verify chunk metadata, orphaned documents, and a known cross-shard query.",
      "Open traffic gradually and watch for routing errors or duplicate keys.",
      "Run the restore drill on a schedule so the scope and timing are known before an incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A coordinated snapshot is consistent but needs a quiet window or a cluster-aware snapshot mechanism.",
      "A logical dump is portable but slower and may not capture one exact cluster time without coordination.",
      "More restore parallelism shortens the window but competes for the same network and disk.",
      "A targeted shard restore is faster but cannot be treated as a cluster recovery.",
      "Keeping the oplog long enough for point-in-time recovery costs disk and increases recovery complexity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cluster-unit",
    question: "What must a backup of a sharded MongoDB cluster contain?",
    difficulty: 3,
    hints: [
      "Data is only one part.",
      "Routing metadata lives somewhere else.",
      "Time matters across components.",
    ],
    answer:
      "It must contain every shard, the config server replica set, and a consistent cluster time. The shards hold the data; the config servers hold the routing table, chunk ranges, and shard identity. The balancer must be stopped or otherwise prevented from moving chunks during the backup window. A backup of one shard is a shard backup, not a cluster backup.",
    followUps: [
      "Why does the balancer matter?",
      "What does the config server store?",
      "How would you verify the backup is complete?",
    ],
    redFlags: [
      "Lists only the shards.",
      "Forgets the config servers.",
      "Ignores the backup window.",
    ],
    rubric: [
      "Names all shards and config servers.",
      "Mentions one cluster time.",
      "Mentions the balancer.",
      "Distinguishes shard from cluster backup.",
    ],
  },
  {
    id: "restore-verify",
    question: "How do you verify a sharded-cluster restore before opening traffic?",
    difficulty: 3,
    hints: [
      "Counts are not enough.",
      "Check the routing table.",
      "Test a query that crosses shards.",
    ],
    answer:
      "I check that every shard and the config servers are present from the intended recovery point, then compare `config.chunks` and `config.shards` with the restored topology. I look for orphaned documents and duplicate keys, run a known cross-shard query, and check a sample of application invariants. Only then do I open traffic gradually and watch for routing errors.",
    followUps: [
      "What is an orphaned document?",
      "How would you test point-in-time recovery?",
      "What would make you abort the restore?",
    ],
    redFlags: [
      "Checks only document counts.",
      "Skips config metadata.",
      "Opens all traffic at once.",
    ],
    rubric: [
      "Verifies scope and time.",
      "Checks routing metadata.",
      "Looks for orphans and duplicates.",
      "Opens traffic gradually.",
    ],
  },
  {
    id: "rpo",
    question:
      "The backup has a 30-minute skew across shards. What recovery point can you honestly promise?",
    difficulty: 3,
    hints: [
      "One cluster state needs one time.",
      "The earliest and latest snapshots bound the choice.",
      "Skew is a data-loss decision.",
    ],
    answer:
      "I cannot honestly promise a single cluster state at the latest time. The safest common point is the earliest snapshot, which means losing writes after that point on the other shards. If the business needs a later point, the backup must be retaken with coordination. I would state the recovery point and the data-loss window explicitly rather than presenting a fast restore as complete.",
    followUps: [
      "How would you reduce skew next time?",
      "What role does the oplog play?",
      "When would you choose the latest snapshot instead?",
    ],
    redFlags: [
      "Claims a point-in-time recovery without a common time.",
      "Ignores the data-loss window.",
      "Restores the latest shard and hopes the rest match.",
    ],
    rubric: [
      "Explains the common-point constraint.",
      "Quantifies the data-loss window.",
      "Chooses the earliest safe point.",
      "Plans a coordinated backup.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The backup scope includes every shard and the config server replica set.",
      "The balancer is stopped or the snapshot mechanism captures the cluster at one time.",
      "Recovery point objective and restore time objective are written down.",
      "A restore drill has been run on a cluster of the same shape.",
      "The runbook includes routing, orphan, and cross-shard verification.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the restore scope before starting any component.",
      "Record the timestamp of every shard and config backup.",
      "Do not present a single-shard restore as a cluster recovery.",
      "Keep writes and the balancer stopped until verification passes.",
      "Watch restore throughput and the shared recovery host bottleneck.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify `config.chunks` and `config.shards` against the restored topology.",
      "Check for orphaned documents and duplicate keys.",
      "Run a known cross-shard query and an application invariant check.",
      "Record the actual recovery point and the data-loss window.",
      "Update the backup schedule or snapshot method to reduce skew.",
    ],
  },
];

const references = [
  {
    title: "Back Up and Restore with Filesystem Snapshots",
    url: "https://www.mongodb.com/docs/manual/tutorial/backup-sharded-cluster-with-filesystem-snapshots/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Sharded-cluster snapshot procedure, including stopping the balancer and capturing all components.",
  },
  {
    title: "MongoDB Backup Methods",
    url: "https://www.mongodb.com/docs/manual/core/backups/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Filesystem snapshots, `mongodump`, and the tradeoffs between backup methods.",
  },
  {
    title: "Config Servers",
    url: "https://www.mongodb.com/docs/manual/core/sharded-cluster-config-servers/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "The config server replica set, cluster metadata, and routing table.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "backup-restore": {
      model: backupRestoreModel,
      presets,
      instructions:
        "Start Healthy, then apply One shard only. Compare with Shards without config to isolate metadata, then apply Coordinated restore. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Restore times, consistency-check counts, and metadata mismatch percentages are teaching values; the documented failure is restoring fragments from different times without the config servers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["databases-backups-pitr", "mongodb-sharding", "mongodb-chunk-migration"],
};
