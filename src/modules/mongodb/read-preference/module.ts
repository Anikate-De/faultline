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

const PRIMARY_CAPACITY = 60_000;
const REPLICA_CAPACITY = 30_000;
const WRITE_RATE = 2_000;
const MAX_READS = 120_000;
const MODE_NAMES = ["primary", "primaryPreferred", "secondary", "secondaryPreferred", "nearest"];

const params: ParamSpec[] = [
  {
    id: "readRate",
    label: "Read rate",
    min: 5_000,
    max: 120_000,
    step: 5_000,
    value: 25_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Read operations per second. The read preference decides which members receive them.",
    format: "rps",
  },
  {
    id: "replicaLag",
    label: "Replication lag",
    min: 0,
    max: 300,
    step: 1,
    value: 0.8,
    unit: "s",
    group: "Replication",
    help: "How far the secondaries are behind the primary. The two secondaries are modeled at 0.7× and 1.3× this value. Values up to five minutes show why a 90-second staleness limit can exclude every secondary.",
    format: "number",
  },
  {
    id: "mode",
    label: "Read preference",
    min: 0,
    max: 4,
    step: 1,
    value: 0,
    unit: "",
    group: "Routing",
    help: "0 primary, 1 primaryPreferred, 2 secondary, 3 secondaryPreferred, 4 nearest. The mode changes which members are eligible and what happens when the primary is unavailable.",
    format: "count",
  },
  {
    id: "maxStaleness",
    label: "Max staleness",
    min: 0,
    max: 540,
    step: 90,
    value: 0,
    unit: "s",
    group: "Freshness",
    help: "0 disables the limit. MongoDB requires at least 90 seconds when the option is set; this model treats values below 90 as 90. The estimate is coarse and is not a per-read freshness guarantee.",
    format: "number",
  },
  {
    id: "primaryAvailable",
    label: "Primary available",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scenario",
    help: "0 models a primary that cannot serve reads. Fallback behavior depends on the read preference mode.",
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

interface Selection {
  mode: number;
  modeName: string;
  primaryAvailable: boolean;
  primaryReads: number;
  secondaryReads: [number, number];
  servedLag: number;
  eligible: number;
  errorRate: number;
  primaryLoad: number;
  secondaryLoads: [number, number];
  worstSecondaryLoad: number;
  replicaLags: [number, number];
  primaryP99: number;
  secondaryP99: number;
  secondaryP99s: [number, number];
  readP99: number;
}

function latency(util: number, base: number): number {
  if (util >= 1) return 250 + (util - 1) * 300;
  return base + (30 * util ** 4) / Math.max(0.05, 1 - util);
}

function compute(p: Params): Selection {
  const readRate = clamp(num(p, "readRate", 25_000), 0, MAX_READS);
  const replicaLag = clamp(num(p, "replicaLag", 0.8), 0, 300);
  const mode = Math.round(clamp(num(p, "mode", 0), 0, 4));
  const rawStaleness = Math.max(0, num(p, "maxStaleness", 0));
  const limit = rawStaleness <= 0 ? Number.POSITIVE_INFINITY : Math.max(90, rawStaleness);
  const primaryAvailable = num(p, "primaryAvailable", 1) >= 0.5;
  const lags: [number, number] = [replicaLag * 0.7, replicaLag * 1.3];
  const eligibleIndexes = [0, 1].filter((index) => lags[index] <= limit);
  const eligible = eligibleIndexes.length;
  const secondaryReads: [number, number] = [0, 0];
  let primaryReads = 0;
  let servedLag = 0;
  let errorRate = 0;

  const splitSecondaries = () => {
    if (eligibleIndexes.length === 0) return false;
    const share = readRate / eligibleIndexes.length;
    for (const index of eligibleIndexes) secondaryReads[index] = share;
    servedLag = Math.max(...eligibleIndexes.map((index) => lags[index]));
    return true;
  };

  if (mode === 0) {
    if (primaryAvailable) primaryReads = readRate;
    else errorRate = 100;
  } else if (mode === 1) {
    if (primaryAvailable) primaryReads = readRate;
    else if (!splitSecondaries()) errorRate = 100;
  } else if (mode === 2) {
    if (!splitSecondaries()) errorRate = 100;
  } else if (mode === 3) {
    if (!splitSecondaries()) {
      if (primaryAvailable) primaryReads = readRate;
      else errorRate = 100;
    }
  } else {
    const candidates: { id: string; distance: number; index: number }[] = [];
    if (primaryAvailable) candidates.push({ id: "primary", distance: 8, index: -1 });
    for (const index of eligibleIndexes) {
      candidates.push({ id: `replica-${index}`, distance: index === 0 ? 3 : 5, index });
    }
    if (candidates.length === 0) {
      errorRate = 100;
    } else {
      const perMember = readRate / candidates.length;
      const chosen = candidates.reduce((best, item) => {
        const load =
          item.index < 0
            ? (WRITE_RATE + perMember) / PRIMARY_CAPACITY
            : perMember / REPLICA_CAPACITY;
        const score = item.distance + load * 10;
        return score < best.score ? { item, score } : best;
      }, { item: candidates[0], score: Number.POSITIVE_INFINITY }).item;
      if (chosen.index < 0) primaryReads = readRate;
      else {
        secondaryReads[chosen.index] = readRate;
        servedLag = lags[chosen.index];
      }
    }
  }

  const primaryLoad = primaryAvailable
    ? ((WRITE_RATE + primaryReads) / PRIMARY_CAPACITY) * 100
    : 0;
  const secondaryLoads: [number, number] = [
    (secondaryReads[0] / REPLICA_CAPACITY) * 100,
    (secondaryReads[1] / REPLICA_CAPACITY) * 100,
  ];
  const worstSecondaryLoad = Math.max(...secondaryLoads);
  const primaryP99 = primaryAvailable
    ? latency((WRITE_RATE + primaryReads) / PRIMARY_CAPACITY, 2)
    : 0;
  const secondaryP99s: [number, number] = [
    secondaryReads[0] > 0 ? latency(secondaryReads[0] / REPLICA_CAPACITY, 4) : 0,
    secondaryReads[1] > 0 ? latency(secondaryReads[1] / REPLICA_CAPACITY, 6) : 0,
  ];
  const secondaryP99 = Math.max(...secondaryP99s);
  const readP99 = errorRate > 0 ? 50 : Math.max(primaryP99, secondaryP99);

  return {
    mode,
    modeName: MODE_NAMES[mode],
    primaryAvailable,
    primaryReads,
    secondaryReads,
    servedLag,
    eligible,
    errorRate,
    primaryLoad,
    secondaryLoads,
    worstSecondaryLoad,
    replicaLags: lags,
    primaryP99,
    secondaryP99,
    secondaryP99s,
    readP99,
  };
}

function loadHealth(value: number): Health {
  if (value >= 90) return "crit";
  if (value >= 75) return "warn";
  return "ok";
}

function lagHealth(value: number): Health {
  if (value >= 10) return "crit";
  if (value >= 3) return "warn";
  return "ok";
}

function latencyHealth(value: number): Health {
  if (value >= 100) return "crit";
  if (value >= 30) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Selection): SimFrame {
  const clientHealth = worst(
    values.errorRate >= 10 ? "crit" : values.errorRate >= 1 ? "warn" : "ok",
    lagHealth(values.servedLag),
  );
  const primaryHealth = values.primaryAvailable
    ? worst(loadHealth(values.primaryLoad), latencyHealth(values.primaryP99))
    : "down";
  const replicaHealth: [Health, Health] = [
    worst(loadHealth(values.secondaryLoads[0]), lagHealth(values.replicaLags[0]), latencyHealth(values.secondaryP99s[0])),
    worst(loadHealth(values.secondaryLoads[1]), lagHealth(values.replicaLags[1]), latencyHealth(values.secondaryP99s[1])),
  ];

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: clientHealth,
      sublabel:
        values.errorRate > 0
          ? "no eligible member"
          : values.servedLag > 0
            ? `served by secondary · ${values.servedLag.toFixed(1)}s stale`
            : "served by primary",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: primaryHealth,
      utilization: clamp(values.primaryLoad / 100),
      throughput: WRITE_RATE + values.primaryReads,
      sublabel: values.primaryAvailable
        ? `${Math.round(values.primaryReads).toLocaleString()} reads/s · p99 ${values.readP99.toFixed(0)}ms`
        : "unavailable",
      detail:
        "The primary accepts writes and serves reads when the read preference selects it. A primary mode does not fall back when the primary is unavailable.",
      meta: { view: "replication", lag: 0 },
    },
    ...([0, 1] as const).map((index) => {
      const lag = values.replicaLags[index];
      return {
        id: `replica-${index + 1}`,
        label: index === 0 ? "Secondary A" : "Secondary B",
        kind: "db" as const,
        role: "replica" as const,
        health: replicaHealth[index],
        utilization: clamp(values.secondaryLoads[index] / 100),
        throughput: values.secondaryReads[index],
        sublabel:
          values.secondaryReads[index] > 0
            ? `${Math.round(values.secondaryReads[index]).toLocaleString()} reads/s · lag ${lag.toFixed(1)}s`
            : `lag ${lag.toFixed(1)}s · no reads`,
        detail:
          "Secondaries apply the primary's oplog asynchronously. Reads routed here can be stale by the replication lag; maxStalenessSeconds only filters candidates that the driver estimates as too far behind.",
        meta: { view: "replication", lag },
      };
    }),
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-primary", "client", "primary", (WRITE_RATE + values.primaryReads) / MAX_READS, primaryHealth),
      edge("client-replica-1", "client", "replica-1", values.secondaryReads[0] / MAX_READS, replicaHealth[0]),
      edge("client-replica-2", "client", "replica-2", values.secondaryReads[1] / MAX_READS, replicaHealth[1]),
    ],
    metrics: [
      metric("read-staleness", "Worst read staleness", values.servedLag, "s", 3, 10, "number"),
      metric("read-error-rate", "Read failure rate", values.errorRate, "%", 1, 10, "percent"),
      metric("secondary-load", "Busiest secondary load", values.worstSecondaryLoad, "%", 75, 90, "percent"),
      metric("read-p99", "Read p99", values.readP99, "ms", 30, 100, "ms"),
      metric("primary-load", "Primary load", values.primaryLoad, "%", 75, 90, "percent"),
      metric("eligible-members", "Eligible secondaries", values.eligible, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, mode: values.mode, primaryAvailable: values.primaryAvailable ? 1 : 0 },
    summary: `${values.modeName} · ${Math.round(values.primaryReads).toLocaleString()} primary reads/s · ${values.servedLag.toFixed(1)}s worst staleness · ${values.eligible} eligible secondaries`,
  };
}

function seedSeries(frame: SimFrame, values: Selection, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 8)) / 2.7);
  const rows: [string, number, number][] = [
    ["read-staleness", values.servedLag, 0.02],
    ["read-error-rate", values.errorRate, 0.1],
    ["secondary-load", values.worstSecondaryLoad, 0.2],
    ["read-p99", values.readP99, 0.3],
    ["primary-load", values.primaryLoad, 0.2],
    ["eligible-members", values.eligible, 0],
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
    id: "read-staleness",
    metricId: "read-staleness",
    warn: 3,
    crit: 10,
    title: "A read is served by a lagging secondary",
    cause: "The selected read preference allows secondary reads, and the secondary is behind the primary by more than the product's tolerance. Asynchronous replication makes this possible even when every node is healthy.",
    fix: "Route freshness-critical reads to the primary. If the read can tolerate staleness, set `maxStalenessSeconds` to a value of at least 90 seconds and make the product's budget explicit. Do not treat nearest as a freshness setting.",
    checkFirst: [
      "Check the read preference on the failing code path.",
      "Check `rs.printSecondaryReplicationInfo()` for lag on the selected member.",
      "Check whether `maxStalenessSeconds` is set and whether it is compatible with the mode.",
    ],
  },
  {
    id: "read-error-rate",
    metricId: "read-error-rate",
    warn: 1,
    crit: 10,
    title: "No eligible member can serve the read",
    cause: "The mode requires a member that is not available. `secondary` has no primary fallback, and `maxStalenessSeconds` can filter every secondary out. A primary mode fails when the primary is unavailable.",
    fix: "Choose the fallback behavior the product needs: `primaryPreferred` if the primary should win, `secondaryPreferred` if a secondary should win but the primary may cover an outage. If strict freshness is required, accept the primary dependency.",
    checkFirst: [
      "Check `rs.status()` for member availability.",
      "Check the mode and max staleness on the failing path.",
      "Check driver server-selection errors for the eligible set.",
    ],
  },
  {
    id: "secondary-load",
    metricId: "secondary-load",
    warn: 75,
    crit: 90,
    title: "The secondary read tier is saturating",
    cause: "Moving reads to secondaries shifts load onto fewer members. If the read share is large or the eligible set shrinks, the busiest secondary approaches its modeled capacity.",
    fix: "Reduce the secondary read share, add read capacity, or send latency-tolerant reads elsewhere. Check that the primary can absorb the reads if the secondary tier fails.",
    checkFirst: [
      "Check per-member CPU, disk I/O, and read latency.",
      "Check how many secondaries are eligible after staleness and tag filters.",
      "Check whether one member receives a disproportionate share.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 30,
    crit: 100,
    title: "Read latency is rising",
    cause: "The selected member is near its modeled capacity. Queueing grows nonlinearly, so adding a small read share can produce a large latency increase.",
    fix: "Reduce the read rate, spread reads across eligible members, or route the reads to a member with headroom. Do not assume a secondary is spare capacity.",
    checkFirst: [
      "Compare load and p99 per member, not the replica set average.",
      "Check for slow queries and disk I/O on the selected member.",
      "Check whether reads are pinned to one secondary.",
    ],
  },
];

export const readPreferenceModel: SimModel = {
  id: "mongodb-read-preference",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
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
      item.id === "read-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const previousMode = Math.round(Number(frame.flags.mode ?? 0));
    if (values.mode !== previousMode) {
      pushEvent(next, {
        id: "read-preference-changed",
        at: frame.t,
        severity: "info",
        title: `Read preference changed to ${values.modeName}`,
        detail:
          values.mode === 0
            ? "All reads now go to the primary. Freshness is strongest, but reads add load to the write path and fail during a primary outage."
            : values.mode === 1
              ? "Reads prefer the primary and fall back to eligible secondaries only when it is unavailable."
              : values.mode === 2
                ? "Reads require a secondary. There is no primary fallback if no secondary is eligible."
                : values.mode === 3
                  ? "Reads prefer eligible secondaries and fall back to the primary when none are available."
                  : "Reads go to a member inside the latency window. The mode does not prefer fresh or stale data by itself.",
      });
    }
    if (!values.primaryAvailable && Number(frame.flags.primaryAvailable ?? 1) === 1) {
      pushEvent(next, {
        id: "primary-unavailable",
        at: frame.t,
        severity: "warn",
        title: "Primary is unavailable",
        detail:
          values.errorRate > 0
            ? "The selected read preference cannot fall back to an eligible secondary, so reads fail."
            : "The selected read preference is using secondaries. Check how stale those reads are.",
      });
    }
    next.flags.primaryAvailable = values.primaryAvailable ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `${values.modeName} sends ${Math.round(values.primaryReads).toLocaleString()} reads/s to the primary and ${Math.round(values.secondaryReads[0] + values.secondaryReads[1]).toLocaleString()} reads/s to secondaries.`,
    ];
    if (values.mode === 4) {
      items.push(
        "Nearest selects a member inside the latency window; it treats primary and secondary equally on freshness. It can return stale data when the nearest eligible member is a lagging secondary.",
      );
    }
    if (!values.primaryAvailable) {
      items.push(
        values.mode === 0
          ? "A primary read preference has no fallback. Reads fail while the primary is unavailable."
          : "The primary is unavailable, so fallback behavior decides whether reads succeed.",
      );
    }
    if (values.eligible < 2) {
      items.push(
        `${values.eligible} of 2 secondaries pass the staleness filter. If the mode requires a secondary and none pass, the read fails rather than silently bypassing the limit.`,
      );
    }
    if (values.servedLag >= 3) {
      items.push(
        `The worst served read is ${values.servedLag.toFixed(1)}s stale. Secondary reads are asynchronous, so this is normal replication behavior, not necessarily a failing node.`,
      );
    }
    items.push(
      values.errorRate > 0
        ? "No eligible member can serve the read with the current mode and filters."
        : `Modeled read p99 is ${values.readP99.toFixed(0)}ms; the busiest secondary is ${values.worstSecondaryLoad.toFixed(0)}% of its illustrative capacity.`,
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
    description: "Primary reads with low replication lag. Freshness is strong and the primary has headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak offload",
    description: "SecondaryPreferred at 48k reads/s. The secondary tier is busy but both members are eligible.",
    tone: "warn",
    params: defaults({ readRate: 48_000, replicaLag: 1.2, mode: 3, maxStaleness: 90, primaryAvailable: 1 }),
  },
  {
    id: "failure",
    label: "Stale dashboard",
    description: "A dashboard uses secondary reads while lag is 12 seconds and no staleness limit is set.",
    tone: "crit",
    params: defaults({ readRate: 30_000, replicaLag: 12, mode: 2, maxStaleness: 0, primaryAvailable: 1 }),
  },
  {
    id: "primary-failure",
    label: "Primary outage",
    description: "PrimaryPreferred falls back to secondaries when the primary is unavailable.",
    tone: "warn",
    params: defaults({ readRate: 30_000, replicaLag: 2, mode: 1, maxStaleness: 90, primaryAvailable: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "PrimaryPreferred reads the primary again with lag inside the product budget.",
    tone: "ok",
    params: defaults({ readRate: 30_000, replicaLag: 1, mode: 1, maxStaleness: 90, primaryAvailable: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-dashboard",
  title: "Choose a read preference for a freshness-sensitive dashboard",
  simId: "read-preference",
  question:
    "An operations dashboard reads from secondaries. Replication lag is 12 seconds and the page shows old data. Which change addresses the freshness problem?",
  prediction: {
    options: [
      { id: "max", label: "Set maxStalenessSeconds to 5 seconds and keep secondary mode" },
      { id: "primary", label: "Move the dashboard to primary reads or primaryPreferred" },
      { id: "nearest", label: "Switch to nearest so the client picks the fastest member" },
      { id: "add", label: "Add a third secondary to spread the reads" },
    ],
    correctOptionId: "primary",
    explanation:
      "MongoDB requires maxStalenessSeconds to be at least 90 seconds, so a 5-second limit is rejected. Secondary mode also has no primary fallback. Primary or primaryPreferred reads from the primary while it is available, which removes replication lag from the read path. Nearest is a latency choice and can still select a stale secondary.",
  },
  setup: defaults({ readRate: 30_000, replicaLag: 12, mode: 2, maxStaleness: 0, primaryAvailable: 1 }),
  runFor: 20,
  observe: [
    "Secondary mode serves every read from a secondary, so the worst staleness follows the 12-second lag.",
    "The staleness metric crosses the critical threshold while every node still reports healthy.",
    "Switching to primaryPreferred sends reads to the primary and drops served staleness to zero.",
    "Primary load rises, which is the cost of stronger freshness.",
  ],
  explain:
    "Read preference is a routing decision, not a consistency setting. Secondary reads are asynchronous and can be stale by the lag. `maxStalenessSeconds` only filters secondary candidates, cannot go below 90 seconds, and is a coarse estimate. If the product cannot tolerate the lag, the read belongs on the primary.",
  fix: defaults({ readRate: 30_000, replicaLag: 12, mode: 1, maxStaleness: 0, primaryAvailable: 1 }),
  debrief:
    "Use primary or primaryPreferred for reads that must reflect the latest write, and accept that they depend on the primary. Use secondaryPreferred with an explicit staleness budget for dashboards, reporting, and other tolerant reads. Reserve nearest for latency-driven routing where stale data is acceptable; it does not make a read fresh.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Read preference tells a MongoDB driver which replica-set members may serve a read. The mode is chosen per operation, collection, database, or client. `primary` sends every read to the primary. `secondary` sends reads only to eligible secondaries. `primaryPreferred` and `secondaryPreferred` add a fallback, and `nearest` chooses from members inside a latency window regardless of role.",
  },
  {
    type: "p",
    text: "The tradeoff is freshness against load and locality. Secondaries apply the primary's oplog asynchronously, so a secondary read can return data from before the latest write. That is not a bug in the secondary; it is the replication model. `maxStalenessSeconds` lets the driver exclude secondaries whose estimated lag exceeds a threshold, but MongoDB requires at least 90 seconds, the estimate is coarse, and the option is not compatible with the `primary` mode.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "diagram",
    id: "replica-lag",
    caption: "Secondary reads can be stale by the replication lag. The read preference decides whether the driver may use one.",
  },
  {
    type: "table",
    headers: ["Mode", "Reads from", "When the primary is unavailable", "Freshness risk"],
    rows: [
      ["primary", "Primary only", "Reads fail", "Lowest; reads the write path"],
      ["primaryPreferred", "Primary, else eligible secondaries", "Falls back to secondaries", "Stale only during fallback"],
      ["secondary", "Eligible secondaries only", "Can continue on secondaries", "Always exposed to lag"],
      ["secondaryPreferred", "Eligible secondaries, else primary", "Falls back to primary", "Stale while a secondary is used"],
      ["nearest", "Member in the latency window", "Can continue on secondaries", "No freshness preference"],
    ],
  },
  {
    type: "p",
    text: "Eligibility is not the same as availability. A member must respond to the driver's monitoring checks, and for modes other than primary it must satisfy `maxStalenessSeconds` and any tag sets. If no member is eligible, the operation fails; a read preference does not guarantee success. That distinction matters for `secondary`, which will not silently fall back to the primary.",
  },
  {
    type: "compare",
    leftTitle: "Freshness-critical read",
    rightTitle: "Tolerant read",
    rows: [
      { label: "Example", left: "Order status after checkout", right: "Internal operations dashboard" },
      { label: "Preference", left: "primary", right: "secondaryPreferred with a staleness budget" },
      { label: "Failure behavior", left: "Fail rather than return old data", right: "Continue on secondaries or the primary" },
      { label: "Cost", left: "Read load stays on the primary", right: "Possible stale reads within the budget" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Worst read staleness: the lag of the member that actually served the read.",
      "Read failure rate: no eligible member, including a missing primary for primary-only modes.",
      "Busiest secondary load and primary load: where the read routing moved the work.",
      "Eligible secondaries: how many pass the staleness filter.",
      "Read p99: queueing on the selected member, not a replica-set average.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with primary reads, then apply Stale dashboard. Watch staleness rise while every node stays healthy. Switch the mode to primaryPreferred and compare; then apply Primary outage to see the fallback path. Use the experiment to commit to a prediction before revealing the explanation.",
  },
  { type: "sim", simId: "read-preference" },
  { type: "experiment", experimentId: "predict-dashboard" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Secondary mode sent every read to a secondary, and the worst served staleness followed the 12-second replication lag. CPU and node health looked fine because the secondary was doing exactly what asynchronous replication allows. The freshness failure was a routing decision, not a saturated node.",
  },
  {
    type: "p",
    text: "Switching to primaryPreferred moved reads to the primary while it was available. Staleness fell to zero and primary load rose. During a primary outage, the same mode fell back to secondaries and reintroduced staleness; the fallback kept reads available but did not preserve freshness.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Driver read preference and server-selection events show which members were eligible.",
      "`rs.printSecondaryReplicationInfo()` shows lag per secondary.",
      "Application traces show stale values or version mismatches on specific read paths.",
      "Primary CPU and read operations rise when secondary reads move back to the primary.",
      "Server selection errors appear when no member satisfies the mode, tags, or staleness limit.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the read preference on the failing code path before touching the database. Then check the selected member's lag and whether `maxStalenessSeconds` is set. If the read must be fresh, route it to the primary; if it can be stale, make the budget explicit and monitor it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the read path and its freshness requirement.",
      "Check replication lag and which member actually served the read.",
      "Move freshness-critical reads to primary or primaryPreferred.",
      "For tolerant reads, keep secondaryPreferred and set a deliberate staleness budget of at least 90 seconds.",
      "Confirm the fallback behavior matches the product: fail, read stale, or use the primary.",
      "Watch primary load after moving reads back; freshness has a capacity cost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Primary reads are fresh but add load to the write path and fail during a primary outage.",
      "Secondary reads reduce primary load but can return stale data by the replication lag.",
      "`maxStalenessSeconds` filters candidates but cannot express sub-90-second freshness.",
      "`secondary` has no primary fallback; `secondaryPreferred` does, at the cost of freshness.",
      "`nearest` reduces network latency but says nothing about whether the data is current.",
      "Adding secondaries spreads read load but does not shorten the lag that makes reads stale.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-mode",
    question: "How do you choose a read preference for a dashboard versus a checkout confirmation page?",
    difficulty: 2,
    hints: [
      "Start with the freshness requirement.",
      "Then decide what should happen when the primary is unavailable.",
      "Load follows the routing decision.",
    ],
    answer:
      "For checkout confirmation, the read must reflect the write the customer just completed, so I would use primary, or a causally consistent session with majority read and write concern if the workflow needs it. For an internal dashboard, stale data within an explicit budget is usually acceptable, so secondaryPreferred with `maxStalenessSeconds` at 90 seconds or more reduces primary load. I would also decide the failure behavior: primary reads fail when the primary is unavailable; secondaryPreferred falls back to the primary.",
    followUps: [
      "What changes if the dashboard shows financial totals?",
      "How would you measure the staleness budget?",
      "When would nearest be appropriate?",
    ],
    redFlags: [
      "Uses secondary for every read to reduce load.",
      "Ignores the primary outage behavior.",
      "Treats maxStalenessSeconds as a strict freshness guarantee.",
    ],
    rubric: [
      "Starts from freshness requirements.",
      "Names specific modes.",
      "Explains fallback behavior.",
      "Accounts for load.",
    ],
  },
  {
    id: "stale-secondary",
    question: "A dashboard shows data 12 seconds old. The secondary is healthy. What is happening, and what would you change?",
    difficulty: 2,
    hints: [
      "Replication is asynchronous.",
      "Check the read preference and lag.",
      "Max staleness is coarse.",
    ],
    answer:
      "The dashboard is using a secondary read while that secondary is 12 seconds behind the primary. The node is healthy; the data is stale because replication is asynchronous. I would check the read preference and the secondary's lag. If the dashboard needs fresher data, I would move it to primary or primaryPreferred. If it can tolerate a budget, I would keep secondaryPreferred and set `maxStalenessSeconds` to at least 90 seconds, understanding that it filters candidates but is not a guarantee of per-read freshness.",
    followUps: [
      "What does maxStalenessSeconds actually compare?",
      "Why can it not be set below 90 seconds?",
      "How would you prove the secondary is applying the oplog?",
    ],
    redFlags: [
      "Restarts the secondary without checking lag.",
      "Believes maxStalenessSeconds can be 5 seconds.",
      "Confuses node health with data freshness.",
    ],
    rubric: [
      "Names asynchronous replication.",
      "Checks mode and lag.",
      "Chooses primary for strict freshness.",
      "Explains the 90-second floor.",
    ],
  },
  {
    id: "primary-outage",
    question: "Compare primaryPreferred and secondaryPreferred during a primary outage.",
    difficulty: 3,
    hints: [
      "Which member wins when both are available?",
      "Which member is the fallback?",
      "Availability and freshness are separate.",
    ],
    answer:
      "primaryPreferred reads the primary when it is available and falls back to eligible secondaries when it is not. secondaryPreferred reads eligible secondaries when they are available and falls back to the primary when none are. During a primary outage, primaryPreferred is the one that must use secondaries, so it keeps reads available but can return stale data. secondaryPreferred already prefers secondaries, so the outage may not change its behavior if secondaries remain eligible.",
    followUps: [
      "What happens if maxStalenessSeconds filters every secondary?",
      "Which mode keeps read-your-writes on the primary?",
      "How does nearest differ from both?",
    ],
    redFlags: [
      "Thinks primaryPreferred always reads the primary.",
      "Forgets the eligibility filter.",
      "Equates availability with freshness.",
    ],
    rubric: [
      "States the preferred member for each.",
      "States the fallback for each.",
      "Explains the outage behavior.",
      "Mentions eligibility.",
    ],
  },
  {
    id: "nearest",
    question: "Why is nearest not a freshness setting?",
    difficulty: 2,
    hints: [
      "It chooses from a latency window.",
      "Primary and secondary are treated equally.",
      "Staleness is still possible.",
    ],
    answer:
      "Nearest selects an eligible member whose network latency is inside the driver's latency window, without preferring a primary or a secondary. The selected member can be a lagging secondary. `maxStalenessSeconds` can filter secondaries, but nearest itself is about latency, not recency. If the product needs current data, use primary or a stronger consistency mechanism, not nearest.",
    followUps: [
      "What is localThresholdMS?",
      "Can nearest choose the primary?",
      "How would you combine nearest with a staleness budget?",
    ],
    redFlags: [
      "Says nearest always picks the geographically closest node.",
      "Assumes nearest returns fresh data.",
      "Ignores maxStalenessSeconds compatibility.",
    ],
    rubric: [
      "Names the latency window.",
      "Notes role-neutral selection.",
      "Mentions staleness filtering.",
      "Chooses primary for freshness.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every read path has an explicit freshness requirement and read preference.",
      "Dashboards and reports use secondaryPreferred with a documented staleness budget.",
      "Freshness-critical paths use primary or a causal session with the right concerns.",
      "The team knows which modes fail versus fall back during a primary outage.",
      "Latency and lag dashboards show per-member read load.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the read preference on the failing path before changing database topology.",
      "Check lag on the member that served the read.",
      "Check whether `maxStalenessSeconds` is filtering all eligible secondaries.",
      "Watch primary load when moving reads back to the primary.",
      "Record whether the failure was freshness, eligibility, or availability.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the chosen mode matches the product's freshness requirement.",
      "Verify the fallback behavior during a controlled primary outage.",
      "Review read load distribution and p99 on the selected members.",
      "Document why the mode and staleness budget are set.",
    ],
  },
];

const references = [
  {
    title: "Read Preference",
    url: "https://www.mongodb.com/docs/manual/core/read-preference/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Mode definitions, eligibility, fallback behavior, and the stale-read warning.",
  },
  {
    title: "Read Preference maxStalenessSeconds",
    url: "https://www.mongodb.com/docs/manual/core/read-preference-staleness/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Eligibility filter, coarse estimate, and the 90-second minimum.",
  },
  {
    title: "Replica Set Secondary Members",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-secondary/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Asynchronous oplog application and the consistency implications of secondary reads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-preference": {
      model: readPreferenceModel,
      presets,
      instructions:
        "Start Healthy, then apply Stale dashboard. Compare modes and watch served staleness and primary load. Apply Primary outage to see fallback behavior. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Capacity, latency, and lag thresholds are teaching values, not MongoDB limits. Read preference and maxStalenessSeconds behavior follows the documented modes.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-replica-set", "mongodb-write-concern", "mongodb-replication-lag"],
};
