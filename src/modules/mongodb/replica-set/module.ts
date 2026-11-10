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

const PRIMARY_CAPACITY = 40_000;
const WRITE_SHARE = 0.3;
const HEARTBEAT_SECONDS = 2;
const ELECTION_SECONDS = 1;
const MAX_OPS = 60_000;

const params: ParamSpec[] = [
  {
    id: "opRate",
    label: "Application operation rate",
    min: 4_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Reads and writes arriving at the replica set. Writes must reach the primary; reads may go to a secondary depending on read preference.",
    format: "rps",
  },
  {
    id: "electionTimeout",
    label: "Election timeout",
    min: 4,
    max: 20,
    step: 1,
    value: 10,
    unit: "s",
    group: "Failover",
    help: "How long members wait without hearing from the primary before calling an election. MongoDB's documented default is 10 seconds; shorter values fail over sooner but can trigger on transient latency.",
    format: "number",
  },
  {
    id: "staleClients",
    label: "Clients with stale topology",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Clients",
    help: "Share of clients still sending to the old primary endpoint after a new primary is elected. This models cached connection pools and stale DNS, not the election itself.",
    format: "percent",
  },
  {
    id: "primaryDown",
    label: "Primary failure",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 removes the primary at t=0. The remaining members must detect the loss, elect a majority winner, and let drivers find it.",
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

interface ElectionState {
  down: boolean;
  failedAt: number;
  elapsed: number;
  detectAt: number;
  electedAt: number;
  phase: "stable" | "detecting" | "electing" | "elected";
}

function stateAt(p: Params, down: boolean, failedAt: number, t: number): ElectionState {
  const electionTimeout = clamp(num(p, "electionTimeout", 10), 4, 20);
  const detectAt = electionTimeout + HEARTBEAT_SECONDS / 2;
  const electedAt = detectAt + ELECTION_SECONDS;
  const elapsed = down ? Math.max(0, t - failedAt) : 0;
  const phase: ElectionState["phase"] = !down
    ? "stable"
    : elapsed < detectAt
      ? "detecting"
      : elapsed < electedAt
        ? "electing"
        : "elected";
  return { down, failedAt, elapsed, detectAt, electedAt, phase };
}

interface Computed {
  opRate: number;
  writeRate: number;
  phase: ElectionState["phase"];
  electionElapsed: number;
  writeErrorRate: number;
  staleClients: number;
  primaryP99: number;
  primaryCpu: number;
  replicaLag: number;
  originalPrimaryHealth: Health;
  candidateHealth: Health;
}

function compute(p: Params, state: ElectionState): Computed {
  const opRate = clamp(num(p, "opRate", 12_000), 0, MAX_OPS);
  const writeRate = opRate * WRITE_SHARE;
  const stale = clamp(num(p, "staleClients", 0), 0, 100);
  const down = state.down;
  const electionElapsed = down ? Math.min(state.elapsed, state.electedAt) : 0;
  const writeErrorRate = !down ? 0 : state.phase === "elected" ? stale : 100;
  const activeStale = down && state.phase === "elected" ? stale : 0;

  const util = opRate / PRIMARY_CAPACITY;
  const stableP99 =
    util >= 1 ? 250 + (util - 1) * 200 : 4 + (25 * util ** 4) / Math.max(0.05, 1 - util);
  const primaryP99 = down
    ? state.phase === "elected"
      ? 30 + activeStale
      : 800
    : Math.min(900, stableP99);
  const primaryCpu = down ? 0 : clamp(util * 100, 0, 120);
  const replicaLag = down ? 0.5 : 0.2 + (writeRate / 40_000) * 0.8;

  const originalPrimaryHealth: Health = down
    ? "down"
    : primaryCpu >= 90 || primaryP99 >= 200
      ? "crit"
      : primaryCpu >= 75 || primaryP99 >= 50
        ? "warn"
        : "ok";
  const candidateHealth: Health = down
    ? state.phase === "elected"
      ? "ok"
      : "warn"
    : replicaLag >= 5
      ? "crit"
      : replicaLag >= 2
        ? "warn"
        : "ok";

  return {
    opRate,
    writeRate,
    phase: state.phase,
    electionElapsed,
    writeErrorRate,
    staleClients: activeStale,
    primaryP99,
    primaryCpu,
    replicaLag,
    originalPrimaryHealth,
    candidateHealth,
  };
}

function formatLag(seconds: number): string {
  return seconds < 1 ? `${(seconds * 1000).toFixed(0)}ms` : `${seconds.toFixed(1)}s`;
}

function buildFrame(seed: number, state: ElectionState, values: Computed): SimFrame {
  const elected = state.down && state.phase === "elected";
  const clientHealth: Health =
    values.writeErrorRate >= 10 ? "crit" : values.writeErrorRate >= 1 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: clientHealth,
      sublabel:
        values.writeErrorRate > 0
          ? `${values.writeErrorRate.toFixed(0)}% writes failing`
          : `${Math.round(values.opRate).toLocaleString()} ops/s`,
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: elected ? "Old primary" : "Primary",
      kind: "db",
      role: elected ? "replica" : "primary",
      health: values.originalPrimaryHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: state.down ? 0 : values.opRate,
      sublabel: state.down
        ? state.phase === "detecting"
          ? "unreachable · election timer"
          : state.phase === "electing"
            ? "unreachable · election running"
            : "stepped down"
        : `p99 ${values.primaryP99.toFixed(0)}ms · ${values.primaryCpu.toFixed(0)}% CPU`,
      detail:
        "The primary accepts writes and records them in its operation log (oplog). If it becomes unreachable, the remaining voting members must elect a replacement before writes can succeed.",
      meta: { view: "replication", lag: 0 },
    },
    {
      id: "replica-1",
      label: elected ? "New primary" : "Secondary A",
      kind: "db",
      role: elected ? "primary" : "replica",
      health: values.candidateHealth,
      utilization: clamp((values.writeRate / 30_000)),
      throughput: values.writeRate,
      sublabel: elected
        ? `elected · lag ${formatLag(values.replicaLag)}`
        : state.down
          ? state.phase === "electing"
            ? "candidate · seeking majority"
            : "waiting for election"
          : `lag ${formatLag(values.replicaLag)}`,
      detail:
        "A secondary applies the primary's oplog asynchronously. It can become primary only after winning a majority of votes and having the most recent optime among visible members.",
      meta: { view: "replication", lag: values.replicaLag },
    },
    {
      id: "replica-2",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: state.down ? values.candidateHealth : "ok",
      utilization: clamp((values.writeRate / 30_000)),
      throughput: values.writeRate,
      sublabel: state.down
        ? state.phase === "elected"
          ? `lag ${formatLag(values.replicaLag)}`
          : "voter · election in progress"
        : `lag ${formatLag(values.replicaLag)}`,
      detail:
        "The second secondary supplies the second vote in a three-member set. A majority is two, so one surviving secondary plus this voter can elect a primary.",
      meta: { view: "replication", lag: values.replicaLag },
    },
  ];

  const edges = [
    edge("client-primary", "client", state.down ? "replica-1" : "primary", values.opRate / MAX_OPS, clientHealth),
    edge(
      "primary-replica-1",
      state.down ? "replica-1" : "primary",
      state.down ? "replica-2" : "replica-1",
      values.writeRate / MAX_OPS,
      values.candidateHealth,
    ),
    edge(
      "primary-replica-2",
      state.down ? "replica-1" : "primary",
      state.down ? "primary" : "replica-2",
      values.writeRate / MAX_OPS,
      state.down ? "warn" : "ok",
    ),
  ];

  const summary = state.down
    ? state.phase === "elected"
      ? `New primary elected · ${values.writeErrorRate.toFixed(0)}% clients still failing · election ${values.electionElapsed.toFixed(0)}s`
      : `No primary · election ${values.electionElapsed.toFixed(0)}s of ${state.electedAt.toFixed(0)}s · ${values.writeErrorRate.toFixed(0)}% writes failing`
    : `${Math.round(values.opRate).toLocaleString()} ops/s · primary ${values.primaryCpu.toFixed(0)}% CPU · p99 ${values.primaryP99.toFixed(0)}ms`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("write-error-rate", "Write failure rate", values.writeErrorRate, "%", 1, 10, "percent"),
      metric("stale-clients", "Clients on old primary", values.staleClients, "%", 5, 25, "percent"),
      metric("election-elapsed", "Election elapsed", values.electionElapsed, "s", 8, 15, "number"),
      metric("primary-p99", "Primary p99", values.primaryP99, "ms", 50, 200, "ms"),
      metric("primary-cpu", "Primary CPU", values.primaryCpu, "%", 75, 90, "percent"),
      metric("replication-lag", "Replication lag", values.replicaLag, "s", 2, 5, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      primaryDown: state.down ? 1 : 0,
      failedAt: state.failedAt,
      phase: state.phase,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 9)) / 2.5);
  const rows: [string, number, number][] = [
    ["write-error-rate", values.writeErrorRate, 0.1],
    ["stale-clients", values.staleClients, 0.1],
    ["election-elapsed", values.electionElapsed, 0.05],
    ["primary-p99", values.primaryP99, 0.4],
    ["primary-cpu", values.primaryCpu, 0.3],
    ["replication-lag", values.replicaLag, 0.02],
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
    id: "write-error-rate",
    metricId: "write-error-rate",
    warn: 1,
    crit: 10,
    title: "Writes cannot reach a primary",
    cause: "The replica set has no writable primary, or clients are still sending to the old primary after a new one was elected. MongoDB cannot process writes until an election completes.",
    fix: "Wait for the election if it is still inside the expected window, then make clients refresh topology. Check `rs.status()` for a PRIMARY, and confirm the application uses a replica-set connection string rather than a single host.",
    checkFirst: [
      "Check `rs.status()` for a member in PRIMARY state and a majority of healthy voting members.",
      "Check the driver's server selection and topology errors, not just the database.",
      "Check DNS and connection strings for a hard-coded old primary host.",
    ],
  },
  {
    id: "stale-clients",
    metricId: "stale-clients",
    warn: 5,
    crit: 25,
    title: "Clients are still using the old primary",
    cause: "The election finished, but a share of clients still send to the old endpoint. This is a discovery problem, not an election problem; a new primary does not fix a cached or hard-coded address.",
    fix: "Use a replica-set connection string so drivers discover the new primary. Fix stale DNS records and restart or recycle pools that hold the old topology. Do not promote the old member back just to satisfy stale clients.",
    checkFirst: [
      "Check connection strings for a single host instead of the replica set.",
      "Check DNS TTLs and whether the old hostname still resolves to the failed node.",
      "Check driver topology events and server selection timeouts.",
    ],
  },
  {
    id: "election-elapsed",
    metricId: "election-elapsed",
    warn: 8,
    crit: 15,
    title: "Failover is taking longer than expected",
    cause: "The election timeout, heartbeat detection, or a slow candidate is extending the window without a primary. MongoDB documents a median failover time that should not typically exceed 12 seconds with default settings.",
    fix: "Check that a majority of voting members are reachable and that the winning secondary has the most recent optime. Lower `electionTimeoutMillis` only after weighing extra elections and rollback risk for `w:1` writes.",
    checkFirst: [
      "Check `rs.status()` for members in RECOVERING or STARTUP2 and for a healthy majority.",
      "Check network latency and packet loss between members.",
      "Check `electionTimeoutMillis` and member priority.",
    ],
  },
  {
    id: "primary-p99",
    metricId: "primary-p99",
    warn: 50,
    crit: 200,
    title: "Primary latency is rising",
    cause: "The primary is approaching its modeled operation capacity. Queueing grows nonlinearly as utilization rises, so a small traffic increase can create a large latency increase.",
    fix: "Reduce primary work, add capacity, or route tolerant reads to secondaries. Do not use an election as a capacity plan.",
    checkFirst: [
      "Compare operation rate with CPU, disk I/O, and slow queries.",
      "Check whether reads that could tolerate staleness are still on the primary.",
      "Check replication lag before moving read load.",
    ],
  },
];

export const replicaSetModel: SimModel = {
  id: "mongodb-replica-set",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const down = num(p, "primaryDown", 0) >= 0.5;
    const state = stateAt(p, down, down ? 0 : -1, 0);
    const values = compute(p, state);
    const frame = buildFrame(seed, state, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const down = num(p, "primaryDown", 0) >= 0.5;
    const previousDown = Number(frame.flags.primaryDown ?? 0) === 1;
    const failedAt = down ? (previousDown ? Number(frame.flags.failedAt ?? 0) : frame.t) : -1;
    const state = stateAt(p, down, failedAt, frame.t);
    const values = compute(p, state);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, state, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.3, 0.3) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "primary-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (down && !Number(next.flags.failureAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-failed",
        at: frame.t,
        severity: "crit",
        title: "Primary is unreachable",
        detail:
          "Writes cannot succeed until a majority of voting members elect a new primary. Secondaries can still serve reads if the read preference allows it.",
        nodeId: "primary",
      });
      next.flags.failureAnnounced = 1;
    }
    if (down && state.phase !== "detecting" && !Number(next.flags.electionAnnounced ?? 0)) {
      pushEvent(next, {
        id: "election-started",
        at: frame.t,
        severity: "warn",
        title: "Election started",
        detail:
          "The election timeout elapsed. An eligible secondary is seeking a majority of votes; a member must also have the most recent optime among visible members to win.",
      });
      next.flags.electionAnnounced = 1;
    }
    if (down && state.phase === "elected" && !Number(next.flags.electedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-elected",
        at: frame.t,
        severity: "info",
        title: "New primary elected",
        detail:
          "The winning secondary can accept writes. Clients must discover the new topology before their writes succeed.",
      });
      next.flags.electedAnnounced = 1;
    }
    if (down && state.phase === "elected" && values.writeErrorRate > 0 && !Number(next.flags.staleAnnounced ?? 0)) {
      pushEvent(next, {
        id: "clients-stale",
        at: frame.t,
        severity: "crit",
        title: "Clients still target the old primary",
        detail: `${values.writeErrorRate.toFixed(0)}% of clients are still failing after the election. This is a client discovery problem, not a missing primary.`,
        nodeId: "client",
      });
      next.flags.staleAnnounced = 1;
    }
    if (!down && previousDown && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "writable-primary-available",
        at: frame.t,
        severity: "info",
        title: "A writable primary is available",
        detail: "The set has a primary again. Confirm that clients have refreshed topology and that lag is inside budget.",
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (!down) {
      next.flags.failureAnnounced = 0;
      next.flags.electionAnnounced = 0;
      next.flags.electedAnnounced = 0;
      next.flags.staleAnnounced = 0;
      next.flags.recoveredAnnounced = 0;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const down = num(p, "primaryDown", 0) >= 0.5;
    const failedAt = down ? Number(frame.flags.failedAt ?? 0) : -1;
    const state = stateAt(p, down, failedAt, frame.t);
    const values = compute(p, state);
    const items: string[] = [];
    if (!down) {
      items.push(
        `The primary is serving ${Math.round(values.opRate).toLocaleString()} ops/s at ${values.primaryCpu.toFixed(0)}% of the illustrative capacity.`,
      );
      items.push(
        `The secondaries apply the oplog asynchronously; modeled lag is ${formatLag(values.replicaLag)}. A lagging secondary is less attractive as an election candidate.`,
      );
    } else if (state.phase === "detecting") {
      items.push(
        `No election has started yet. Members wait for the ${num(p, "electionTimeout", 10).toFixed(0)}s election timeout before calling one; heartbeats are every ${HEARTBEAT_SECONDS}s in MongoDB.`,
      );
      items.push("Every write during this window fails because there is no primary that can acknowledge it.");
    } else if (state.phase === "electing") {
      items.push(
        "A candidate is collecting votes. A majority of voting members is required, and the winner must have the most recent optime among visible members.",
      );
      items.push("Clients with a primary read preference cannot read during this window either.");
    } else {
      items.push(
        `A new primary is elected after roughly ${state.electedAt.toFixed(1)}s in this model. MongoDB documents a median failover that should not typically exceed 12 seconds with defaults.`,
      );
      items.push(
        values.staleClients > 0
          ? `${values.staleClients.toFixed(0)}% of clients still send to the old primary and keep failing. Promoting the old node back would not fix a stale connection string.`
          : "All modeled clients have refreshed topology and writes succeed again.",
      );
    }
    if (values.primaryP99 >= 50) {
      items.push(
        `Primary p99 is ${values.primaryP99.toFixed(0)}ms. The latency curve is illustrative; the shape is queueing as utilization approaches capacity.`,
      );
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
    description: "A three-member set with a stable primary, two secondaries, and 12k ops/s.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "32k ops/s without a failure. The primary is busy, but the set is intact.",
    tone: "warn",
    params: defaults({ opRate: 32_000 }),
  },
  {
    id: "failure",
    label: "Primary failure",
    description: "The primary disappears at t=0 and 40% of clients keep the old topology after the election.",
    tone: "crit",
    params: defaults({ opRate: 12_000, electionTimeout: 10, staleClients: 40, primaryDown: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A primary is available and clients use the replica-set connection string.",
    tone: "ok",
    params: defaults({ opRate: 10_000, electionTimeout: 10, staleClients: 0, primaryDown: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-failover",
  title: "Predict what clients see when the primary disappears",
  simId: "replica-set",
  question:
    "The primary fails. The election timeout is 10 seconds and 40% of clients still have the old topology cached. What do clients see?",
  prediction: {
    options: [
      { id: "instant", label: "Writes move to a secondary immediately and no client sees an error" },
      { id: "window", label: "All writes fail until the election completes, then every client recovers at once" },
      { id: "stale", label: "Writes fail during the election, then the clients with stale topology keep failing" },
      { id: "reads", label: "Only reads fail; writes continue on the old primary" },
    ],
    correctOptionId: "stale",
    explanation:
      "There is no writable primary while the members detect the failure and elect a replacement. Once a new primary exists, a client still using the old endpoint keeps failing until its driver refreshes topology or the connection string points at the replica set. The election and the client discovery are two separate problems.",
  },
  setup: defaults({ opRate: 12_000, electionTimeout: 10, staleClients: 40, primaryDown: 1 }),
  runFor: 20,
  observe: [
    "Writes fail at 100% while the set has no primary.",
    "The election completes after the election timeout plus vote time, around 12 seconds with these settings.",
    "Write failures fall but do not reach zero because 40% of clients still target the old primary.",
    "The old primary is unavailable while a secondary has the primary role.",
  ],
  explain:
    "A replica set does not have a hot standby that takes over instantly. Members exchange heartbeats, wait out the election timeout, and require a majority of votes. The new primary then has to be discovered by drivers. A hard-coded host or stale DNS entry bypasses that discovery and turns a short election into a longer application outage.",
  fix: defaults({ opRate: 10_000, electionTimeout: 10, staleClients: 0, primaryDown: 0 }),
  debrief:
    "After the election, verify that `rs.status()` shows one PRIMARY and that a majority of voting members are healthy. Then verify the application path: replica-set connection string, DNS, and driver topology events. Lowering the election timeout can shorten the window, but it also increases elections on transient latency and the rollback risk for writes acknowledged with `w:1`.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB replica set is a group of `mongod` processes that maintain the same data set. One member is the primary and receives writes. The others are secondaries: they copy the primary's operation log (oplog) and apply its entries asynchronously. If the primary becomes unreachable, an eligible secondary can win an election and become the new primary.",
  },
  {
    type: "p",
    text: "The oplog is a capped collection in the `local` database. It records operations that modify data, and every member keeps a copy. Replication is asynchronous, so a secondary can be behind. That lag is normal within a small window; it becomes a correctness and availability problem when it grows or when the secondary is needed as an election candidate.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "diagram",
    id: "replica-lag",
    caption: "The primary accepts writes and records them in the oplog; secondaries apply those entries and can serve reads if the read preference allows it.",
  },
  {
    type: "p",
    text: "Applications connect through a MongoDB driver with a replica-set connection string. The driver monitors the members and routes writes to the current primary. With the default `primary` read preference, reads also go to the primary. A secondary read preference moves reads, but the data can be stale by the replication lag.",
  },
  {
    type: "p",
    text: "Elections are driven by a majority of voting members. In a three-member set, two votes are enough. A candidate must also have the most recent optime among visible members. MongoDB documents an `electionTimeoutMillis` default of 10 seconds and heartbeats every two seconds; the median failover should not typically exceed 12 seconds with default settings. Network latency can extend it.",
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it does not tell you"],
    rows: [
      ["`rs.status()`", "Member state, health, term, and optime", "Whether the application can discover the new primary"],
      ["`rs.printSecondaryReplicationInfo()`", "How far each secondary is behind", "Why the lag is growing"],
      ["Driver topology events", "Which member the client selects and when", "Whether the database is healthy"],
      ["`db.hello()`", "The member's role and election metadata", "Whether a majority can still vote"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Write failure rate: writes fail while there is no primary, and can keep failing if clients use a stale endpoint.",
      "Election elapsed: how much of the detection and voting window has passed.",
      "Clients on the old primary: the share that has not refreshed topology after the election.",
      "Primary p99 and CPU: the stable-state cost of the operation rate.",
      "Replication lag: how far the secondaries are behind the primary.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Primary failure. Watch the write failure rate stay at 100% until the election completes, then fall to the stale-client share. Set stale clients to zero to separate election time from client discovery. Use the experiment to predict the sequence before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "One primary, one oplog",
    body: "A secondary is not a read-write copy. It applies the primary's oplog and can become primary only through an election. If a client still writes to an old primary after a new one exists, those writes do not become committed data; they fail or are rolled back.",
  },
  { type: "sim", simId: "replica-set" },
  { type: "experiment", experimentId: "predict-failover" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary disappeared, so the set had no member that could acknowledge writes. The remaining members waited out the election timeout, exchanged votes, and elected a secondary that had the most recent optime. Writes failed for that whole window. Once the new primary existed, clients with a stale endpoint continued to fail because they were still sending to the old node.",
  },
  {
    type: "p",
    text: "The election and the client recovery were separate. The election produced a writable primary; the driver's topology discovery decided when each client could use it. Lowering the election timeout shortened the first window but did not fix the second.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`rs.status()` shows one PRIMARY, the rest SECONDARY, and a healthy majority of voting members.",
      "Application errors include `NotWritablePrimary`, server selection timeouts, or connection failures to the old host.",
      "Driver topology events show the old primary removed and the new primary selected.",
      "`rs.printSecondaryReplicationInfo()` shows lag on the remaining secondaries.",
      "The old primary may return as a secondary and must resync or roll back any writes that were never majority-committed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check `rs.status()` for a PRIMARY and a voting majority before changing anything. If a primary exists but writes still fail, check the client connection string, DNS, and driver topology. If no primary exists, check member health, network reachability, and whether enough voting members are available.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the set has a primary and a majority of healthy voting members.",
      "If the election is still inside the expected window, wait and watch; do not force a reconfiguration.",
      "If no primary can be elected, restore connectivity or majority before retrying writes.",
      "If a primary exists but clients fail, fix discovery: replica-set connection string, DNS, and stale pools.",
      "Verify the old primary rejoins as a secondary and does not accept writes.",
      "Check replication lag and application retry behavior before declaring recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A lower election timeout shortens the no-primary window but can trigger elections on transient network latency.",
      "More frequent elections increase the chance of rollbacks for writes acknowledged with `w:1`.",
      "Serving reads from secondaries reduces primary load but exposes stale data within the lag window.",
      "A replica set survives a member loss, but not the loss of a voting majority.",
      "Retryable writes handle some failover errors once, but they are not a substitute for correct topology discovery.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "draw-the-set",
    question: "Draw a three-member MongoDB replica set and explain what happens when the primary fails.",
    difficulty: 2,
    hints: [
      "Start with the write path and the oplog.",
      "Elections need a majority, not every member.",
      "The client has its own discovery step.",
    ],
    answer:
      "A three-member set has one primary and two secondaries. The primary accepts writes and records them in its oplog; each secondary copies and applies that oplog asynchronously. If the primary becomes unreachable, members wait for the election timeout, then an eligible secondary seeks votes. A majority, two of three, must vote for it, and the winner must have the most recent optime among visible members. Writes fail until that completes. Drivers then discover the new primary through the replica-set connection string; a client with a hard-coded old host keeps failing.",
    followUps: [
      "What happens if only one secondary is reachable?",
      "Why does the winner need the most recent optime?",
      "How does a stale DNS record change the failure?",
    ],
    redFlags: [
      "Says a secondary accepts writes without an election.",
      "Thinks a majority means all members.",
      "Ignores client discovery.",
    ],
    rubric: [
      "Names primary, secondaries, and oplog.",
      "Requires a majority and an eligible candidate.",
      "Explains the no-primary write window.",
      "Separates election from client discovery.",
    ],
  },
  {
    id: "majority",
    question: "Why can a three-member replica set tolerate one failed member but not two?",
    difficulty: 2,
    hints: [
      "Count votes, not data copies.",
      "A primary needs a majority to be elected.",
      "The remaining set must still form a majority.",
    ],
    answer:
      "Elections require a majority of voting members. In a three-member set the majority is two. With one member down, the other two can still form a majority and elect a primary. With two down, only one voting member remains, which is not a majority, so no primary can be elected and writes stop. The same arithmetic applies to network partitions: the side with the majority can elect a primary; the minority side cannot.",
    followUps: [
      "How does an arbiter change the arithmetic?",
      "What is the difference between a voting member and a data-bearing member?",
      "What happens in a five-member set?",
    ],
    redFlags: [
      "Counts data-bearing members as enough without votes.",
      "Says two nodes are always a majority.",
      "Ignores network partitions.",
    ],
    rubric: [
      "States the majority rule.",
      "Applies it to three members.",
      "Distinguishes votes from data copies.",
      "Mentions partitions.",
    ],
  },
  {
    id: "write-window",
    question: "Writes fail for 12 seconds during failover. What determines that window, and what would you change?",
    difficulty: 3,
    hints: [
      "Detection, election, and discovery are separate.",
      "`electionTimeoutMillis` defaults to 10 seconds.",
      "A lower timeout has a cost.",
    ],
    answer:
      "The window includes detecting that the primary is unreachable, calling and completing an election, and the client finding the new primary. MongoDB documents heartbeats every two seconds and an `electionTimeoutMillis` default of 10 seconds; the median failover should not typically exceed 12 seconds with defaults. I would first confirm a majority is healthy and the client uses a replica-set connection string. I would lower the election timeout only if the network is stable, because shorter timeouts cause more elections and increase rollback risk for `w:1` writes.",
    followUps: [
      "What does `catchUpTimeoutMillis` change?",
      "How do retryable writes affect the application impact?",
      "When would you not tune the timeout?",
    ],
    redFlags: [
      "Tunes the timeout before checking majority health.",
      "Assumes the driver reconnects instantly.",
      "Ignores rollback risk.",
    ],
    rubric: [
      "Separates detection, election, and discovery.",
      "Names the default and its tradeoff.",
      "Checks majority and client configuration.",
      "Mentions rollback risk.",
    ],
  },
  {
    id: "stale-topology",
    question: "A new primary is elected, but one service still reports write failures. What do you check?",
    difficulty: 2,
    hints: [
      "The database may be healthy.",
      "The failing service could have an old address.",
      "Driver topology events are evidence.",
    ],
    answer:
      "I would check whether that service uses a replica-set connection string or a single host, then check DNS and its driver topology events. A service with a hard-coded old primary or a stale DNS record keeps sending to a node that is no longer primary. I would not promote the old node back. I would fix discovery by correcting the connection string or DNS, then recycle the pool so the driver refreshes topology.",
    followUps: [
      "How would you prove the database is healthy?",
      "Why not just restart the old primary?",
      "What does `serverSelectionTimeoutMS` control?",
    ],
    redFlags: [
      "Promotes the old primary to satisfy one client.",
      "Blames the election without checking the client.",
      "Restarts the database before checking the connection string.",
    ],
    rubric: [
      "Checks connection string and DNS.",
      "Uses driver topology evidence.",
      "Avoids promoting the old node.",
      "Recycles the client pool.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Applications use a replica-set connection string, not a single primary host.",
      "Dashboards show member state, election count, replication lag, and client server-selection errors.",
      "The team knows the voting majority and which members can become primary.",
      "Retryable writes are enabled where the driver supports them.",
      "DNS TTLs and failover behavior are documented and tested.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check `rs.status()` for a PRIMARY and a healthy voting majority.",
      "Separate the no-primary window from stale-client failures.",
      "Watch for repeated elections, which can indicate network instability.",
      "Do not force a reconfiguration that removes voting members.",
      "Record the election timeline and the client errors.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the old primary rejoined as a secondary and did not accept writes.",
      "Check replication lag and any rollback on the old primary.",
      "Verify every service refreshed topology.",
      "Review whether the election timeout is appropriate for the network.",
    ],
  },
];

const references = [
  {
    title: "Replication and Replica Set Fundamentals",
    url: "https://www.mongodb.com/docs/manual/replication/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Primary, secondaries, asynchronous replication, automatic failover, and the documented failover window.",
  },
  {
    title: "Replica Set Elections",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-elections/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Election triggers, heartbeats, voting members, priority, and the 12-second median guidance.",
  },
  {
    title: "Replica Set Oplog",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-oplog/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Capped oplog, idempotent operations, oplog window, and replication lag.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "replica-set": {
      model: replicaSetModel,
      presets,
      instructions:
        "Start Healthy, then apply Primary failure. Watch write failures during the election, then set stale clients to zero and compare. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Capacity, latency, and the exact election timeline are teaching values; MongoDB documents a 10-second default election timeout and a median failover that should not typically exceed 12 seconds.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-read-preference", "mongodb-write-concern", "mongodb-elections"],
};
