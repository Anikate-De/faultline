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

const HEARTBEAT_SECONDS = 2;
const ELECTION_SECONDS = 0.5;
const DRIVER_SECONDS = 0.5;

const params: ParamSpec[] = [
  {
    id: "primaryFailed",
    label: "Primary failure",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 removes the primary. The remaining members must detect the loss, elect a majority winner, catch the winner up, and let drivers find it.",
    format: "count",
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
    help: "How long members wait without hearing from the primary before calling an election. MongoDB's documented default is 10 seconds. Shorter values detect faster but can elect on transient latency.",
    format: "number",
  },
  {
    id: "catchUpLag",
    label: "Candidate catch-up",
    min: 0,
    max: 15,
    step: 1,
    value: 0,
    unit: "s",
    group: "Failover",
    help: "How far the winning secondary is behind when it is elected. With `catchUpTimeoutMillis` at its default of -1, the new primary may catch up with other members before accepting writes. This slider bounds that wait.",
    format: "number",
  },
  {
    id: "writeTimeout",
    label: "Application write timeout",
    min: 1,
    max: 30,
    step: 1,
    value: 5,
    unit: "s",
    group: "Client",
    help: "How long an application operation waits before it fails. If the write outage exceeds this budget, in-flight writes fail instead of waiting for the new primary.",
    format: "number",
  },
  {
    id: "writeRate",
    label: "Write rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 5_000,
    unit: " writes/s",
    group: "Traffic",
    help: "Writes arriving during the failure. The rate sets the impact of the outage and the primary's steady-state CPU.",
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

interface ElectionState {
  failed: boolean;
  failedAt: number;
  elapsed: number;
  detectAt: number;
  electedAt: number;
  caughtUpAt: number;
  resumedAt: number;
  total: number;
  phase: "stable" | "detecting" | "electing" | "catching-up" | "reconnecting" | "writes-resumed";
}

function stateAt(p: Params, failed: boolean, failedAt: number, t: number): ElectionState {
  const timeout = clamp(num(p, "electionTimeout", 10), 4, 20);
  const catchUp = clamp(num(p, "catchUpLag", 0), 0, 15);
  const detectAt = timeout + HEARTBEAT_SECONDS / 2;
  const electedAt = detectAt + ELECTION_SECONDS;
  const caughtUpAt = electedAt + catchUp;
  const resumedAt = caughtUpAt + DRIVER_SECONDS;
  const elapsed = failed ? Math.max(0, t - failedAt) : 0;
  const phase: ElectionState["phase"] = !failed
    ? "stable"
    : elapsed < detectAt
      ? "detecting"
      : elapsed < electedAt
        ? "electing"
        : elapsed < caughtUpAt
          ? "catching-up"
          : elapsed < resumedAt
            ? "reconnecting"
            : "writes-resumed";
  return {
    failed,
    failedAt,
    elapsed,
    detectAt,
    electedAt,
    caughtUpAt,
    resumedAt,
    total: resumedAt,
    phase,
  };
}

interface Computed {
  failed: boolean;
  phase: ElectionState["phase"];
  totalOutage: number;
  outageElapsed: number;
  writeErrorRate: number;
  timeoutOverrun: number;
  electionElapsed: number;
  writeP99: number;
  primaryCpu: number;
  writeRate: number;
  writeTimeout: number;
  catchUp: number;
  detectAt: number;
}

function compute(p: Params, state: ElectionState): Computed {
  const writeRate = clamp(num(p, "writeRate", 5_000), 0, 20_000);
  const writeTimeout = clamp(num(p, "writeTimeout", 5), 1, 30);
  const catchUp = clamp(num(p, "catchUpLag", 0), 0, 15);
  const inOutage = state.failed && state.phase !== "writes-resumed";
  const writeErrorRate = inOutage ? 100 : 0;
  const timeoutOverrun = inOutage ? Math.max(0, state.total - writeTimeout) : 0;
  const electionElapsed = state.failed ? Math.min(state.elapsed, state.total) : 0;
  const writeP99 = inOutage ? Math.min(5_000, writeTimeout * 1_000) : 4 + (writeRate / 20_000) * 8;
  const primaryCpu = state.failed ? 0 : clamp((writeRate / 20_000) * 100, 0, 120);

  return {
    failed: state.failed,
    phase: state.phase,
    totalOutage: state.total,
    outageElapsed: state.elapsed,
    writeErrorRate,
    timeoutOverrun,
    electionElapsed,
    writeP99,
    primaryCpu,
    writeRate,
    writeTimeout,
    catchUp,
    detectAt: state.detectAt,
  };
}

function cpuHealth(value: number): Health {
  if (value >= 90) return "crit";
  if (value >= 75) return "warn";
  return "ok";
}

function buildFrame(seed: number, state: ElectionState, values: Computed): SimFrame {
  const newPrimaryExists =
    state.failed &&
    (state.phase === "catching-up" ||
      state.phase === "reconnecting" ||
      state.phase === "writes-resumed");
  const clientHealth: Health =
    values.writeErrorRate >= 10 ? "crit" : values.writeErrorRate >= 1 ? "warn" : "ok";
  const primaryHealth: Health = state.failed ? "down" : cpuHealth(values.primaryCpu);
  const candidateHealth: Health = !state.failed
    ? "ok"
    : state.phase === "writes-resumed"
      ? "ok"
      : state.phase === "catching-up"
        ? "warn"
        : "ok";

  const phaseLabel =
    state.phase === "detecting"
      ? "no heartbeat · timer running"
      : state.phase === "electing"
        ? "seeking majority"
        : state.phase === "catching-up"
          ? `catching up ${values.catchUp}s`
          : state.phase === "reconnecting"
            ? "new primary · client discovery"
            : state.phase === "writes-resumed"
              ? "writes resumed"
              : "stable";

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: clientHealth,
      sublabel:
        values.writeErrorRate > 0
          ? `writes failing · budget ${values.writeTimeout}s`
          : `${Math.round(values.writeRate).toLocaleString()} writes/s`,
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: newPrimaryExists ? "Old primary" : "Primary",
      kind: "db",
      role: newPrimaryExists ? "replica" : "primary",
      health: primaryHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: state.failed ? 0 : values.writeRate,
      sublabel: state.failed ? phaseLabel : `${values.primaryCpu.toFixed(0)}% CPU · p99 ${values.writeP99.toFixed(0)}ms`,
      detail:
        state.failed
          ? "The old primary is unreachable. It must not accept writes after a new primary exists; when it returns it rejoins as a secondary and rolls back any operations that were not majority-committed."
          : "The primary accepts writes and records them in its oplog. A majority of voting members is required to elect a replacement if it becomes unavailable.",
      meta: { view: "replication", lag: 0 },
    },
    {
      id: "replica-1",
      label: newPrimaryExists ? "New primary" : "Secondary A",
      kind: "db",
      role: newPrimaryExists ? "primary" : "replica",
      health: candidateHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.writeRate,
      sublabel: newPrimaryExists ? phaseLabel : "candidate voter",
      detail:
        "An eligible secondary can win with a majority of votes and the most recent optime among visible members. With protocol version 1 it may also catch up with other members before accepting writes.",
      meta: { view: "replication", lag: state.failed ? 0.2 : 0.2 },
    },
    {
      id: "replica-2",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: "ok",
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.writeRate,
      sublabel: state.failed ? "voter · majority peer" : "second voter",
      detail:
        "In a three-member set the second secondary supplies the second vote. Without it, the remaining secondary cannot form a majority on its own.",
      meta: { view: "replication", lag: 0.2 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge(
        "client-primary",
        "client",
        newPrimaryExists ? "replica-1" : "primary",
        values.writeRate / 20_000,
        clientHealth,
      ),
      edge(
        "primary-replica-1",
        newPrimaryExists ? "replica-1" : "primary",
        newPrimaryExists ? "replica-2" : "replica-1",
        values.writeRate / 20_000,
        candidateHealth,
      ),
      edge(
        "primary-replica-2",
        newPrimaryExists ? "replica-1" : "primary",
        newPrimaryExists ? "primary" : "replica-2",
        values.writeRate / 20_000,
        state.failed ? "warn" : "ok",
      ),
    ],
    metrics: [
      metric("write-error-rate", "Write failure rate", values.writeErrorRate, "%", 1, 10, "percent"),
      metric("timeout-overrun", "Timeout budget overrun", values.timeoutOverrun, "s", 1, 3, "number"),
      metric("election-elapsed", "Election elapsed", values.electionElapsed, "s", 15, 25, "number"),
      metric("write-p99", "Write p99", values.writeP99, "ms", 100, 1_000, "ms"),
      metric("primary-cpu", "Primary CPU", values.primaryCpu, "%", 75, 90, "percent"),
      metric("write-rate", "Write rate", values.writeRate, "writes/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      primaryFailed: state.failed ? 1 : 0,
      failedAt: state.failedAt,
      phase: state.phase,
    },
    summary: state.failed
      ? `${phaseLabel} · ${values.writeErrorRate.toFixed(0)}% writes failing · projected outage ${state.total.toFixed(1)}s · budget ${values.writeTimeout.toFixed(0)}s`
      : `${Math.round(values.writeRate).toLocaleString()} writes/s · primary ${values.primaryCpu.toFixed(0)}% CPU · p99 ${values.writeP99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 11)) / 2.4);
  const rows: [string, number, number][] = [
    ["write-error-rate", values.writeErrorRate, 0.1],
    ["timeout-overrun", values.timeoutOverrun, 0.05],
    ["election-elapsed", values.electionElapsed, 0.05],
    ["write-p99", values.writeP99, 0.4],
    ["primary-cpu", values.primaryCpu, 0.3],
    ["write-rate", values.writeRate, 10],
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
    title: "Writes fail while there is no primary",
    cause: "A replica set cannot process writes until a majority of voting members elect a new primary. The old primary is unreachable or no longer writable.",
    fix: "Wait for the election if it is inside the expected window. If it is not, check that a majority of voting members are reachable and that the client is using the replica-set connection string.",
    checkFirst: [
      "Check `rs.status()` for a PRIMARY and a healthy voting majority.",
      "Check network reachability and member states.",
      "Check client topology errors and the connection string.",
    ],
  },
  {
    id: "timeout-overrun",
    metricId: "timeout-overrun",
    warn: 1,
    crit: 3,
    title: "The election outlasts the write timeout budget",
    cause: "The application gives up before the election, catch-up, and client discovery finish. In-flight writes fail even though the database is still progressing toward a new primary.",
    fix: "Raise the client's server-selection or operation budget above the expected failover window, or shorten the failover. Keep retries bounded and idempotent; do not raise the timeout without checking the caller's remaining budget.",
    checkFirst: [
      "Compare the election timeout, catch-up, and client timeout.",
      "Check `serverSelectionTimeoutMS` and the driver retry configuration.",
      "Check whether the application retries writes safely.",
    ],
  },
  {
    id: "election-elapsed",
    metricId: "election-elapsed",
    warn: 15,
    crit: 25,
    title: "Failover is taking longer than the expected window",
    cause: "Detection, election, catch-up, or client discovery is extending the no-primary period. The documented median failover should not typically exceed 12 seconds with default settings.",
    fix: "Check that a majority is reachable and the winning secondary is caught up. Tune `electionTimeoutMillis` only after weighing extra elections and rollback risk for `w:1` writes.",
    checkFirst: [
      "Check `rs.status()` for the election state and member optimes.",
      "Check network latency and packet loss between members.",
      "Check whether `catchUpTimeoutMillis` is extending the transition.",
    ],
  },
  {
    id: "primary-cpu",
    metricId: "primary-cpu",
    warn: 75,
    crit: 90,
    title: "The primary is approaching its capacity",
    cause: "The steady-state write rate is near the modeled primary capacity. This is a capacity problem, not an election problem.",
    fix: "Reduce write work, add capacity, or move tolerant reads off the primary. Do not use a failover as a capacity plan.",
    checkFirst: [
      "Compare write rate with CPU, disk, and write latency.",
      "Check for hot documents or long-running operations.",
      "Check whether the primary has headroom for a failover.",
    ],
  },
];

export const electionsModel: SimModel = {
  id: "mongodb-elections",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const state = stateAt(p, false, -1, 0);
    const values = compute(p, state);
    const frame = buildFrame(seed, state, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const failed = num(p, "primaryFailed", 0) >= 0.5;
    const previousFailed = Number(frame.flags.primaryFailed ?? 0) === 1;
    const failedAt = failed ? (previousFailed ? Number(frame.flags.failedAt ?? 0) : frame.t) : -1;
    const state = stateAt(p, failed, failedAt, frame.t);
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
      item.id === "write-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (failed && !Number(next.flags.failureAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-failure",
        at: frame.t,
        severity: "crit",
        title: "Primary failed",
        detail:
          "Members will wait out the election timeout, then a candidate needs a majority of votes. Writes cannot be acknowledged until a new primary is available.",
        nodeId: "primary",
      });
      next.flags.failureAnnounced = 1;
    }
    if (failed && state.phase !== "detecting" && !Number(next.flags.electionAnnounced ?? 0)) {
      pushEvent(next, {
        id: "election-called",
        at: frame.t,
        severity: "warn",
        title: "Election called",
        detail:
          "An eligible secondary is seeking a majority. The winner must also have the most recent optime among visible members.",
      });
      next.flags.electionAnnounced = 1;
    }
    if (failed && state.phase !== "detecting" && state.phase !== "electing" && !Number(next.flags.electedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "new-primary-elected",
        at: frame.t,
        severity: "info",
        title: "New primary elected",
        detail:
          values.catchUp > 0
            ? `The new primary is catching up for about ${values.catchUp}s before it accepts writes.`
            : "The new primary is ready to accept writes; clients still need to discover it.",
      });
      next.flags.electedAnnounced = 1;
    }
    if (failed && state.phase === "writes-resumed" && !Number(next.flags.resumedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "writes-resumed",
        at: frame.t,
        severity: "info",
        title: "Writes resumed",
        detail: `The projected outage was ${state.total.toFixed(1)}s against a ${values.writeTimeout.toFixed(0)}s write budget.`,
      });
      next.flags.resumedAnnounced = 1;
    }
    if (failed && values.catchUp > 0 && state.phase === "catching-up" && !Number(next.flags.catchUpAnnounced ?? 0)) {
      pushEvent(next, {
        id: "catching-up",
        at: frame.t,
        severity: "warn",
        title: "New primary is catching up",
        detail:
          "With `catchUpTimeoutMillis` at its default of -1, the elected primary may reconcile with other members before it accepts writes. The outage includes this catch-up.",
      });
      next.flags.catchUpAnnounced = 1;
    }
    if (!failed && previousFailed && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "writable-primary",
        at: frame.t,
        severity: "info",
        title: "A writable primary is available",
        detail: "Verify the application has refreshed topology and that write retries are bounded and idempotent.",
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (!failed) {
      next.flags.failureAnnounced = 0;
      next.flags.electionAnnounced = 0;
      next.flags.electedAnnounced = 0;
      next.flags.resumedAnnounced = 0;
      next.flags.catchUpAnnounced = 0;
      next.flags.recoveredAnnounced = 0;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const failed = num(p, "primaryFailed", 0) >= 0.5;
    const failedAt = failed ? Number(frame.flags.failedAt ?? 0) : -1;
    const state = stateAt(p, failed, failedAt, frame.t);
    const values = compute(p, state);
    const items: string[] = [];
    if (!failed) {
      items.push(
        `The primary is serving ${Math.round(values.writeRate).toLocaleString()} writes/s at ${values.primaryCpu.toFixed(0)}% of the illustrative capacity.`,
      );
      items.push(
        "A majority of voting members can elect a replacement if the primary fails. In a three-member set that majority is two.",
      );
      return items;
    }
    items.push(
      `Breakdown: detection ${(state.detectAt).toFixed(1)}s + election ${ELECTION_SECONDS}s + catch-up ${values.catchUp}s + client discovery ${DRIVER_SECONDS}s = ${state.total.toFixed(1)}s projected outage.`,
    );
    items.push(
      state.phase === "detecting"
        ? `Members are still waiting for the ${num(p, "electionTimeout", 10).toFixed(0)}s election timeout. Heartbeats are every ${HEARTBEAT_SECONDS}s in MongoDB.`
        : state.phase === "electing"
          ? "A candidate is collecting votes. A majority is required; a member with stale optime cannot win."
          : state.phase === "catching-up"
            ? "The new primary is reconciling with other members before it accepts writes. This catch-up is part of the outage."
            : state.phase === "reconnecting"
              ? "The new primary exists and drivers are discovering it. A client with the old topology still fails."
              : "The new primary accepts writes. The old primary must rejoin as a secondary and roll back any uncommitted operations.",
    );
    items.push(
      values.timeoutOverrun > 0
        ? `The outage exceeds the ${values.writeTimeout.toFixed(0)}s application budget by ${values.timeoutOverrun.toFixed(1)}s. In-flight writes will time out even though the election succeeds.`
        : `The ${values.writeTimeout.toFixed(0)}s application budget covers the projected outage.`,
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
    description: "A stable three-member set with a 10-second election timeout and a 5-second write budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "16k writes/s without a failure. The primary is busy but the set is intact.",
    tone: "warn",
    params: defaults({ writeRate: 16_000 }),
  },
  {
    id: "failure",
    label: "Primary failure",
    description: "The primary fails. Detection, election, and discovery take about 12 seconds against a 5-second budget.",
    tone: "crit",
    params: defaults({ primaryFailed: 1, electionTimeout: 10, catchUpLag: 0, writeTimeout: 5 }),
  },
  {
    id: "slow-election",
    label: "Slow election with catch-up",
    description: "A 20-second timeout and 4-second catch-up extend the outage well past the write budget.",
    tone: "crit",
    params: defaults({ primaryFailed: 1, electionTimeout: 20, catchUpLag: 4, writeTimeout: 5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A primary is available and the write budget covers a normal failover.",
    tone: "ok",
    params: defaults({ primaryFailed: 0, electionTimeout: 10, catchUpLag: 0, writeTimeout: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-outage",
  title: "Predict what sets the failover write outage",
  simId: "elections",
  question:
    "The primary fails and writes fail for about 12 seconds. The application write timeout is 5 seconds. What determines the outage?",
  prediction: {
    options: [
      { id: "restart", label: "The time for the old primary to restart and rejoin" },
      { id: "election", label: "The election timeout plus election, catch-up, and client discovery" },
      { id: "disk", label: "The time to fsync the last write on the surviving secondaries" },
      { id: "concern", label: "The write concern used by the application" },
    ],
    correctOptionId: "election",
    explanation:
      "The set has no writable primary while members detect the failure, elect a majority winner, let the winner catch up if needed, and clients discover it. With a 10-second election timeout, two-second heartbeats, a short election, and client discovery, the window is about 12 seconds. Write concern affects durability, not the election timing.",
  },
  setup: defaults({ primaryFailed: 1, electionTimeout: 10, catchUpLag: 0, writeTimeout: 5, writeRate: 5_000 }),
  runFor: 20,
  observe: [
    "Writes fail at 100% while there is no primary.",
    "The election elapsed metric reaches about 12 seconds and then stops.",
    "The timeout overrun shows that the 5-second budget is shorter than the outage.",
    "Writes resume on the new primary, but the old primary remains unavailable.",
  ],
  explain:
    "A failover is a sequence, not an instant. Election timeout dominates the window; catch-up and client discovery add to it. The application budget must cover the sequence, or writes will fail even though the database eventually recovers. Lowering the election timeout shortens detection but increases sensitivity to transient latency.",
  fix: defaults({ primaryFailed: 0, electionTimeout: 8, catchUpLag: 0, writeTimeout: 15, writeRate: 5_000 }),
  debrief:
    "Set the client's server-selection and operation budget above the expected failover window, and make retries bounded and idempotent. Keep the election timeout appropriate for the network; shorter is not automatically better. Test the whole sequence, including catch-up and driver discovery, rather than assuming the database is available as soon as a primary is elected.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB replica set uses elections to choose one primary. Members send heartbeats every two seconds. If the primary does not communicate for the configured election timeout, an eligible secondary calls an election. A majority of voting members must vote for the candidate, and the winner must have the most recent optime among visible members.",
  },
  {
    type: "p",
    text: "Writes cannot be processed until the election succeeds. With default settings, the documented median time before a new primary is elected should not typically exceed 12 seconds, including marking the old primary unavailable and completing the election. Network latency, catch-up, and client discovery can add to the observed application outage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "compare",
    leftTitle: "What the database does",
    rightTitle: "What the application sees",
    rows: [
      { label: "Detection", left: "Heartbeats stop; the election timeout runs", right: "Writes fail or wait; reads on secondaries may continue" },
      { label: "Election", left: "A candidate seeks a majority and the newest optime", right: "Still no writable primary" },
      { label: "Catch-up", left: "The new primary may reconcile before accepting writes", right: "The outage continues even though a winner exists" },
      { label: "Discovery", left: "The new primary is writable", right: "Drivers must find it before requests succeed" },
    ],
  },
  {
    type: "p",
    text: "The election timeout is the main tunable. MongoDB documents `electionTimeoutMillis` with a default of 10 seconds and heartbeats every two seconds. Lowering it detects failure faster, but it can also start elections on transient latency and increase the chance of rollbacks for writes acknowledged with `w:1`. `catchUpTimeoutMillis` defaults to -1, which means the newly elected primary may catch up with other members for as long as needed before accepting writes.",
  },
  {
    type: "table",
    headers: ["Budget", "What it covers", "Typical mistake"],
    rows: [
      ["Election timeout", "Time without a primary heartbeat before an election", "Setting it below the network's normal jitter"],
      ["Catch-up", "Time for the winner to reconcile before writes", "Assuming election means writable"],
      ["Client discovery", "Time for the driver to select the new primary", "Hard-coding the old primary host"],
      ["Operation timeout", "Total time the caller will wait", "Setting it shorter than the failover it expects"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Write failure rate: writes have no primary to acknowledge them.",
      "Timeout budget overrun: how much longer the outage is than the application's write timeout.",
      "Election elapsed: detection plus election, catch-up, and discovery progress.",
      "Write p99: the failure latency while the client waits.",
      "Primary CPU: the steady-state load before the failure.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Primary failure. Watch the write failure rate stay high until the election and discovery complete. Compare Slow election with catch-up, then raise the write budget in Recovery. Use the experiment to predict the outage components before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "A majority is not optional",
    body: "If too few voting members are reachable, no primary can be elected and writes stop until the majority is restored. A replica set does not trade safety for availability during a partition.",
  },
  { type: "sim", simId: "elections" },
  { type: "experiment", experimentId: "predict-outage" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary failed and the remaining members waited out the election timeout. A candidate won a majority, and with the default catch-up setting it became writable only after reconciling. Drivers then discovered it. Writes failed for the whole sequence, not only for the vote itself. The application's 5-second budget was shorter than the roughly 12-second outage.",
  },
  {
    type: "p",
    text: "The slow-election preset added a 20-second timeout and a 4-second catch-up. The database still recovered, but the application had already given up. The failover was correct; the client budget and the election configuration were not matched to each other.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`rs.status()` shows the election state, the new PRIMARY, and member optimes.",
      "Application errors include `NotWritablePrimary`, server selection timeouts, or connection failures.",
      "Driver topology events show when the new primary is discovered.",
      "`rs.printSecondaryReplicationInfo()` shows whether the winner was behind before the election.",
      "The old primary rejoins as a secondary and rolls back writes that were not majority-committed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether a majority of voting members is reachable and whether `rs.status()` shows a PRIMARY. If a primary exists but the application still fails, check client discovery and the operation budget. If no primary exists, check member health and network connectivity before tuning timeouts.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the set has a healthy voting majority.",
      "Measure the actual failover window: detection, election, catch-up, and discovery.",
      "Raise the client server-selection and operation budget above that window.",
      "Keep retries bounded and idempotent; enable retryable writes where supported.",
      "Lower the election timeout only if the network is stable and rollback risk is acceptable.",
      "Test a controlled failover and verify writes resume within the budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A lower election timeout shortens detection but can trigger elections on transient latency.",
      "More frequent elections increase rollback risk for `w:1` writes.",
      "A longer client timeout tolerates failover but consumes the caller's remaining budget.",
      "Catch-up protects against rollback but extends the no-write window.",
      "A majority requirement preserves safety but makes the set unavailable when too few voting members remain.",
      "Retryable writes handle some failover errors once, not every application-level ambiguity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "breakdown",
    question: "Writes failed for 12 seconds after the primary died. Break that window down.",
    difficulty: 3,
    hints: [
      "Detection is not election.",
      "Catch-up and discovery come after the vote.",
      "The documented median includes detection and election.",
    ],
    answer:
      "First, members detect that the primary is unreachable; with the default `electionTimeoutMillis` of 10 seconds and heartbeats every two seconds, that dominates the window. Then a candidate calls an election and needs a majority. After winning, it may catch up with other members before it accepts writes, depending on `catchUpTimeoutMillis`. Finally, the driver discovers the new primary. MongoDB documents a median failover that should not typically exceed 12 seconds with defaults, including marking the primary unavailable and completing the election; real outages can be longer with latency, catch-up, or slow clients.",
    followUps: [
      "Which part can you tune safely?",
      "Where does catch-up fit?",
      "What does the driver add?",
    ],
    redFlags: [
      "Attributes the whole window to the vote.",
      "Ignores client discovery.",
      "Tunes the timeout without checking the network.",
    ],
    rubric: [
      "Separates detection, election, catch-up, discovery.",
      "Names the 10-second default.",
      "Cites the 12-second median guidance.",
      "Mentions application impact.",
    ],
  },
  {
    id: "majority",
    question: "Why does a replica set stop accepting writes when it loses a voting majority?",
    difficulty: 2,
    hints: [
      "A primary needs a majority to be elected.",
      "Two conflicting primaries would be unsafe.",
      "Safety over availability.",
    ],
    answer:
      "A primary is elected by a majority of voting members. If the remaining members cannot form a majority, no candidate can win, so no primary can safely accept writes. This prevents two partitions from both electing a primary and accepting conflicting writes. The set chooses consistency and safety over write availability until the majority is restored.",
    followUps: [
      "What happens to reads on the minority side?",
      "How does an arbiter affect the majority?",
      "Why can a five-member set tolerate two failures?",
    ],
    redFlags: [
      "Says any surviving node can become primary.",
      "Suggests forcing a minority primary is safe.",
      "Confuses reads with writes.",
    ],
    rubric: [
      "Names the majority requirement.",
      "Explains split-brain prevention.",
      "Accepts the availability loss.",
      "Applies the arithmetic.",
    ],
  },
  {
    id: "timeout",
    question: "Should you lower electionTimeoutMillis to make failover faster?",
    difficulty: 3,
    hints: [
      "Shorter detection has a cost.",
      "Transient latency can look like failure.",
      "Rollback risk for w:1.",
    ],
    answer:
      "Only after checking the network and the cost. A lower timeout detects failures faster, but it can also start elections when the primary is merely slow or the network is jittery. More elections increase the chance of rollbacks for writes acknowledged with `w:1`. I would keep the default unless the network is stable and the application needs a shorter window, and I would test the change under realistic latency.",
    followUps: [
      "What does `catchUpTimeoutMillis` change?",
      "How would you measure election frequency?",
      "What is the safer alternative to a shorter timeout?",
    ],
    redFlags: [
      "Lowers the timeout unconditionally.",
      "Ignores transient latency.",
      "Forgets rollback risk.",
    ],
    rubric: [
      "States the benefit.",
      "States the cost.",
      "Checks network stability.",
      "Mentions rollback risk.",
    ],
  },
  {
    id: "client-budget",
    question: "The database elects a new primary in 12 seconds, but the application times out at 5 seconds. What do you change?",
    difficulty: 2,
    hints: [
      "The database may be behaving correctly.",
      "The caller's budget matters.",
      "Retries must be safe.",
    ],
    answer:
      "The application budget is shorter than the expected failover, so in-flight writes fail even though the database recovers. I would raise the server-selection or operation budget above the measured failover window, or shorten the failover if that is safe. I would also make retries bounded and idempotent, and enable retryable writes where the driver supports them. The new timeout must still fit inside the caller's remaining budget.",
    followUps: [
      "What is `serverSelectionTimeoutMS`?",
      "Why does retryable writes help only once?",
      "How would you test the new budget?",
    ],
    redFlags: [
      "Only raises the timeout without checking callers.",
      "Retries non-idempotent writes.",
      "Assumes the database is broken.",
    ],
    rubric: [
      "Diagnoses the budget mismatch.",
      "Raises the budget or shortens failover.",
      "Requires idempotent retries.",
      "Tests the end-to-end window.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The expected failover window is measured, including catch-up and client discovery.",
      "Client server-selection and operation timeouts exceed that window where needed.",
      "Retryable writes are enabled and application retries are idempotent.",
      "The team knows the voting majority and which members can become primary.",
      "Election count and failover duration are monitored.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether a majority of voting members is reachable.",
      "Check `rs.status()` for a PRIMARY and member optimes.",
      "Separate database election time from client discovery time.",
      "Do not force a minority primary to restore writes.",
      "Record the actual outage against the application budget.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the old primary rejoined as a secondary and rolled back uncommitted writes.",
      "Verify writes resume within the intended budget.",
      "Review whether the election timeout fits the network.",
      "Check retry amplification and duplicate side effects.",
    ],
  },
];

const references = [
  {
    title: "Replica Set Elections",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-elections/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Election triggers, heartbeats, majority voting, eligible candidates, and the 12-second median guidance.",
  },
  {
    title: "Self-Managed Replica Set Configuration",
    url: "https://www.mongodb.com/docs/manual/reference/replica-configuration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "`electionTimeoutMillis`, `catchUpTimeoutMillis`, heartbeat settings, and voting member configuration.",
  },
  {
    title: "Retryable Writes",
    url: "https://www.mongodb.com/docs/manual/core/retryable-writes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "How drivers retry certain writes once during failover and why the server-selection timeout matters.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    elections: {
      model: electionsModel,
      presets,
      instructions:
        "Start Healthy, then apply Primary failure. Watch the write failure rate and timeout overrun. Compare Slow election with catch-up, then raise the write budget in Recovery. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. The exact outage is a teaching value; MongoDB documents a 10-second default election timeout, two-second heartbeats, and a median failover that should not typically exceed 12 seconds.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-replica-set", "mongodb-write-concern", "mongodb-replication-lag"],
};
