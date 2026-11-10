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

const CONCERN_NAMES = ["local", "majority", "linearizable", "snapshot"];
const FAILOVER_SECONDS = 3;

const params: ParamSpec[] = [
  {
    id: "readConcern",
    label: "Read concern",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Consistency",
    help: "0 = local, 1 = majority, 2 = linearizable, 3 = snapshot. The level decides what the read is allowed to see, before any read preference chooses a member.",
    format: "count",
  },
  {
    id: "replicationLag",
    label: "Replication lag",
    min: 0,
    max: 2_000,
    step: 50,
    value: 50,
    unit: " ms",
    group: "Topology",
    help: "How far the secondaries are behind the primary. A local read can return data inside this window; a majority read waits for the majority commit point.",
    format: "ms",
  },
  {
    id: "primaryCrash",
    label: "Primary crash",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 crashes the primary. Writes that were acknowledged by only one member can be rolled back when a new primary takes over.",
    format: "count",
  },
  {
    id: "readRate",
    label: "Read rate",
    min: 1_000,
    max: 40_000,
    step: 1_000,
    value: 10_000,
    unit: " reads/s",
    group: "Traffic",
    help: "Reads per second. Higher rates add queueing latency; they do not change what a read concern is allowed to see.",
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
  concern: number;
  concernName: string;
  lag: number;
  crash: boolean;
  readRate: number;
  newPrimary: boolean;
  rollbackRate: number;
  staleAge: number;
  readP99: number;
  readErrorRate: number;
  majorityWait: number;
}

function compute(p: Params, t: number): Computed {
  const concern = Math.round(clamp(num(p, "readConcern", 1), 0, 3));
  const lag = clamp(num(p, "replicationLag", 50), 0, 2_000);
  const crash = num(p, "primaryCrash", 0) >= 0.5;
  const readRate = clamp(num(p, "readRate", 10_000), 0, 60_000);
  const newPrimary = crash && t >= FAILOVER_SECONDS;

  const rollbackRate = crash && concern === 0 ? clamp(6 + lag / 60, 0, 100) : 0;
  const staleAge = concern === 0 ? lag : concern === 3 ? lag * 0.4 : 0;
  const base =
    concern === 0
      ? 2 + lag * 0.05
      : concern === 1
        ? 4 + lag * 0.35
        : concern === 2
          ? 10 + lag * 0.6
          : 5 + lag * 0.4;
  const loadFactor = readRate / 40_000;
  const readP99 = base * (1 + loadFactor ** 3 * 3);
  const readErrorRate = crash && concern === 2 && t < FAILOVER_SECONDS ? 100 : 0;
  const majorityWait = concern >= 1 ? lag * 0.5 : 0;

  return {
    concern,
    concernName: CONCERN_NAMES[concern],
    lag,
    crash,
    readRate,
    newPrimary,
    rollbackRate,
    staleAge,
    readP99,
    readErrorRate,
    majorityWait,
  };
}

function health(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const appHealth = values.readErrorRate >= 5 ? "crit" : health(values.rollbackRate, 0.5, 5);
  const oldPrimaryHealth: Health = values.crash ? "down" : "ok";
  const candidateHealth: Health = values.crash ? (values.newPrimary ? "ok" : "warn") : "ok";

  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application",
      kind: "client",
      health: appHealth,
      sublabel:
        values.rollbackRate > 0
          ? `${values.rollbackRate.toFixed(0)}% reads later rolled back`
          : `${values.concernName} · p99 ${values.readP99.toFixed(0)}ms`,
      detail:
        "The application chooses the read concern. The driver may also choose a member through read preference, but read preference does not raise the consistency guarantee of the read concern.",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: values.newPrimary ? "Old primary" : "Primary",
      kind: "db",
      role: values.newPrimary ? "replica" : "primary",
      health: oldPrimaryHealth,
      utilization: values.crash ? 0 : clamp(values.readRate / 40_000),
      sublabel: values.crash
        ? values.newPrimary
          ? "restarted · not primary"
          : "crashed · failover in progress"
        : `${values.lag.toFixed(0)}ms lag`,
      detail:
        "A local read from the primary can return a write that has not reached a majority. If the primary crashes before replication, that write can be rolled back.",
      meta: { view: "flow", lag: values.lag },
    },
    {
      id: "replica-1",
      label: values.newPrimary ? "New primary" : "Secondary A",
      kind: "db",
      role: values.newPrimary ? "primary" : "replica",
      health: values.newPrimary ? "ok" : candidateHealth,
      utilization: values.newPrimary
        ? clamp(values.readRate / 40_000)
        : clamp(values.readRate / 80_000),
      sublabel: values.newPrimary
        ? "elected after crash"
        : `applying oplog · ${values.lag.toFixed(0)}ms behind`,
      detail:
        "A secondary applies the oplog asynchronously. A majority read waits until data acknowledged by a majority is visible; a local read does not wait.",
      meta: { view: "flow", lag: values.lag },
    },
    {
      id: "replica-2",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: "ok",
      utilization: clamp(values.readRate / 80_000),
      sublabel: `applying oplog · ${values.lag.toFixed(0)}ms behind`,
      detail:
        "The second secondary supplies the majority in a three-member set. Majority read concern is about the commit point, not a particular member.",
      meta: { view: "flow", lag: values.lag },
    },
  ];

  const edges = [
    edge(
      "app-primary",
      "app",
      values.newPrimary ? "replica-1" : "primary",
      clamp(values.readRate / 40_000),
      appHealth,
    ),
    edge(
      "primary-replica-1",
      values.newPrimary ? "replica-1" : "primary",
      values.newPrimary ? "replica-2" : "replica-1",
      values.crash ? 0.1 : clamp(values.readRate / 80_000),
      candidateHealth,
    ),
    edge(
      "primary-replica-2",
      values.newPrimary ? "replica-1" : "primary",
      values.newPrimary ? "primary" : "replica-2",
      values.crash ? 0.05 : clamp(values.readRate / 80_000),
      "ok",
    ),
  ];

  const state = values.crash && !values.newPrimary ? "failover in progress" : "steady";
  const summary =
    values.rollbackRate > 0
      ? `${values.concernName} reads · ${values.rollbackRate.toFixed(0)}% later rolled back · stale age ${values.staleAge.toFixed(0)}ms`
      : `${values.concernName} reads · p99 ${values.readP99.toFixed(0)}ms · lag ${values.lag.toFixed(0)}ms · ${state}`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("rolled-back-reads", "Rolled-back reads", values.rollbackRate, "%", 0.5, 5, "percent"),
      metric("stale-age", "Stale read age", values.staleAge, "ms", 500, 1_500, "ms"),
      metric("read-p99", "Read p99", values.readP99, "ms", 100, 300, "ms"),
      metric("read-errors", "Read errors", values.readErrorRate, "%", 1, 5, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      concern: values.concern,
      crash: values.crash ? 1 : 0,
      newPrimary: values.newPrimary ? 1 : 0,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 8)) / 2.7);
  const rows: [string, number, number][] = [
    ["rolled-back-reads", values.rollbackRate, 0.05],
    ["stale-age", values.staleAge, 0.5],
    ["read-p99", values.readP99, 0.3],
    ["read-errors", values.readErrorRate, 0.02],
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
    id: "rolled-back-reads",
    metricId: "rolled-back-reads",
    warn: 0.5,
    crit: 5,
    title: "Reads are returning data that can be rolled back",
    cause:
      "Read concern `local` returns the most recent data on the queried member without a guarantee that a majority has acknowledged it. If the primary crashes before replication, a new primary can roll that data back.",
    fix: "Use read concern `majority` for data that must survive failover, and pair it with majority write concern. If the product can tolerate stale or provisional data, keep local and document the risk.",
    checkFirst: [
      "Check the read concern on the query, not only the write concern on the write.",
      "Check whether the primary crashed with unreplicated writes.",
      "Check whether the read was served by a secondary that is behind.",
    ],
  },
  {
    id: "stale-age",
    metricId: "stale-age",
    warn: 500,
    crit: 1_500,
    title: "Reads are returning old data",
    cause:
      "The queried member is behind the primary, or the read concern is snapshot-based and reading an older cluster time. Local reads do not wait for replication; a secondary read can be stale by the lag.",
    fix: "Use majority read concern for a majority-committed view, or route the read to the primary. Reduce replication lag before serving consistency-sensitive reads from secondaries.",
    checkFirst: [
      "Check the read preference and which member served the read.",
      "Check replication lag and the secondary's optime.",
      "Check whether a causal session is needed to read your own writes.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 100,
    crit: 300,
    title: "Read latency is above the consistency budget",
    cause:
      "Stronger read concerns can wait for a majority commit point or for the primary to confirm it can still write with majority. Linearizable reads are documented as potentially much slower than local or majority reads.",
    fix: "Use the weakest read concern the product can tolerate, keep linearizable reads rare and indexed by a unique filter, and set `maxTimeMS` so a blocked read returns an error instead of holding a request open.",
    checkFirst: [
      "Check which read concern and read preference the slow query uses.",
      "Check majority commit latency and replication lag.",
      "Check whether a linearizable read is missing `maxTimeMS`.",
    ],
  },
  {
    id: "read-errors",
    metricId: "read-errors",
    warn: 1,
    crit: 5,
    title: "Reads cannot be satisfied during failover",
    cause:
      "Linearizable read concern is only available on the primary. During an election there may be no primary that can satisfy it, so the read waits or fails.",
    fix: "Use majority read concern where linearizable is not required, and set `maxTimeMS` on the reads that must fail fast. Retry after the election with a bounded budget.",
    checkFirst: [
      "Check whether the query requires linearizable read concern.",
      "Check for a primary and a majority of voting members.",
      "Check whether the driver is retrying reads or only writes.",
    ],
  },
];

export const readConcernModel: SimModel = {
  id: "mongodb-read-concern",
  visual: "flow",
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

    const jitter = rng.between(-0.3, 0.3) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "read-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.crash && !Number(next.flags.crashAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-crashed",
        at: frame.t,
        severity: "crit",
        title: "Primary crashed",
        detail:
          "Writes acknowledged by only one member can be rolled back when a new primary takes over. Reads that saw those writes cannot be undone.",
        nodeId: "primary",
      });
      next.flags.crashAnnounced = 1;
    }
    if (values.newPrimary && !Number(next.flags.electedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "new-primary",
        at: frame.t,
        severity: "info",
        title: "New primary elected",
        detail:
          "The surviving majority elected a new primary. Writes acknowledged by a majority are preserved; unreplicated writes may be rolled back.",
        nodeId: "replica-1",
      });
      next.flags.electedAnnounced = 1;
    }
    if (values.rollbackRate >= 5 && !Number(next.flags.rollbackAnnounced ?? 0)) {
      pushEvent(next, {
        id: "local-read-rollback",
        at: frame.t,
        severity: "crit",
        title: "Local reads returned data that was later rolled back",
        detail: `${values.rollbackRate.toFixed(0)}% of reads saw writes that were not majority-committed. The read concern allowed the data to be visible before it was durable.`,
        nodeId: "app",
        metricId: "rolled-back-reads",
      });
      next.flags.rollbackAnnounced = 1;
    }
    if (values.concern >= 1 && values.crash && !Number(next.flags.waitedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "majority-read-wait",
        at: frame.t,
        severity: "warn",
        title: "Majority reads are waiting for the commit point",
        detail:
          "The stronger read concern waits until a majority-committed view is available. That is the cost that prevents the rolled-back read.",
        nodeId: "app",
      });
      next.flags.waitedAnnounced = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `Read concern ${values.concernName} is modeled at ${values.readP99.toFixed(0)}ms p99 with ${values.lag.toFixed(0)}ms replication lag. Read preference chooses a member; read concern chooses what that member may return.`,
    );
    if (values.concern === 0) {
      items.push(
        "Local is the default and can return data that has not reached a majority. That is fine for a feed or a dashboard and wrong for a value you will act on financially.",
      );
    } else if (values.concern === 1) {
      items.push(
        "Majority returns data acknowledged by a majority, so it is durable across a failover. It may wait for the majority commit point, but does not confirm that the current primary can still write.",
      );
    } else if (values.concern === 2) {
      items.push(
        "Linearizable reads only run on the primary and may wait for concurrent writes to propagate to a majority. Use a unique filter and `maxTimeMS`; they are documented as potentially much slower.",
      );
    } else {
      items.push(
        "Snapshot returns majority-committed data from one point in time. In a transaction it gives a stable view; outside a transaction it is limited to certain read operations.",
      );
    }
    if (values.crash) {
      items.push(
        "The primary crashed. Writes that were acknowledged by only one member can be rolled back; a read that already returned them cannot un-see them.",
      );
    }
    if (values.majorityWait > 0) {
      items.push(
        `A majority read can wait about ${values.majorityWait.toFixed(0)}ms in this model. That wait is the price of not returning provisional data.`,
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
    description:
      "Majority read concern with 50ms lag and no crash. Durability and latency are both inside budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "Majority reads at 25,000/s with 400ms lag. The consistency guarantee holds, but latency is near the warning line.",
    tone: "warn",
    params: defaults({ readConcern: 1, replicationLag: 400, readRate: 25_000 }),
  },
  {
    id: "failure",
    label: "Local read after crash",
    description:
      "Local reads with 1.2s lag while the primary crashes. Reads return writes that were never majority-committed.",
    tone: "crit",
    params: defaults({ readConcern: 0, replicationLag: 1_200, primaryCrash: 1, readRate: 20_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "Majority reads with low lag and no crash. Reads are durable and latency is back inside budget.",
    tone: "ok",
    params: defaults({ readConcern: 1, replicationLag: 40, primaryCrash: 0, readRate: 8_000 }),
  },
  {
    id: "linearizable",
    label: "Linearizable",
    description:
      "Linearizable reads at 300ms lag. No rolled-back data, but each read pays for a primary confirmation.",
    tone: "warn",
    params: defaults({ readConcern: 2, replicationLag: 300, primaryCrash: 0, readRate: 15_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-rollback",
  title: "Which read concern returned data that later disappeared?",
  simId: "read-concern",
  question:
    "A service reads an order with read preference primary and the default read concern. The primary crashes before the write reaches a majority, and the order disappears after failover. Which read concern allowed that read?",
  prediction: {
    options: [
      { id: "local", label: "Local, the default read concern on a primary" },
      { id: "majority", label: "Majority, because it waits for the majority commit point" },
      { id: "linearizable", label: "Linearizable, because it only reads from the primary" },
      { id: "snapshot", label: "Snapshot, because it reads a recent point in time" },
    ],
    correctOptionId: "local",
    explanation:
      "Read concern `local` returns the most recent data on the queried member without a guarantee that a majority has acknowledged it. A primary read preference does not add durability. When the primary crashes, a write that reached only that member can be rolled back. Majority, linearizable, and snapshot all provide a majority-committed view; local does not.",
  },
  setup: defaults({ readConcern: 0, replicationLag: 800, primaryCrash: 1, readRate: 12_000 }),
  runFor: 15,
  observe: [
    "Rolled-back reads rise as soon as the local read concern is combined with a crash.",
    "Stale read age tracks the replication lag; the read did not wait for replication.",
    "A majority read concern on the same crash removes the rolled-back reads at the cost of waiting.",
    "The new primary is elected after the failover interval; it does not restore data that was never majority-committed.",
  ],
  explain:
    "Read concern is about visibility, not about which member serves the read. Local can return a write that is visible on one node but not durable across the replica set. Majority waits for a majority-committed view. Linearizable adds a primary confirmation and unique-filter requirement. Snapshot gives a point-in-time majority-committed view, mostly inside transactions.",
  fix: defaults({ readConcern: 1, replicationLag: 50, primaryCrash: 0, readRate: 10_000 }),
  debrief:
    "Check the read concern on the query that produced the bad value, then check the write concern on the write. A majority read cannot rescue a write that was acknowledged with `w:1` and then rolled back before it reached a majority; read and write concerns must be chosen together.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Read concern controls what a MongoDB read is allowed to see. It is set per operation or per transaction and is separate from read preference, which chooses a member. A primary read preference with local read concern can still return data that is not majority-committed; a secondary read preference with majority read concern still waits for the majority view.",
  },
  {
    type: "p",
    text: "The default is `local`: return the most recent data on the queried member. Local is fast and can be correct for dashboards, feeds, and caches that can tolerate a rollback. It is the wrong choice when a read drives an irreversible decision and the write might not survive a primary crash.",
  },
  {
    type: "p",
    text: "`majority` returns data acknowledged by a majority of members, so returned documents are durable across a failover. `linearizable` reads only from the primary and confirms that the primary can still complete majority writes; it requires a unique filter for its guarantee and should use `maxTimeMS`. `snapshot` returns majority-committed data from one point in time, mostly inside multi-document transactions.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A read travels from the driver to a member chosen by read preference, then the server applies the read concern at that member. With a replica set, the majority commit point is the boundary between provisional and durable data. A write acknowledged with `w:1` can be visible to a local read before it reaches that boundary.",
  },
  {
    type: "table",
    headers: ["Read concern", "What it guarantees", "What it costs"],
    rows: [
      [
        "`local`",
        "Most recent data on the queried member",
        "Can return data that is later rolled back",
      ],
      ["`majority`", "Data acknowledged by a majority", "Waits for the majority commit point"],
      [
        "`linearizable`",
        "Reads reflect majority writes before the read started",
        "Primary only, unique filter, potentially much slower",
      ],
      [
        "`snapshot`",
        "Majority-committed data at one point in time",
        "Limited operations; most useful in transactions",
      ],
    ],
  },
  {
    type: "compare",
    leftTitle: "Read preference",
    rightTitle: "Read concern",
    rows: [
      {
        label: "Question",
        left: "Which member should serve the read?",
        right: "What may that member return?",
      },
      {
        label: "Options",
        left: "primary, primaryPreferred, secondary, nearest",
        right: "local, majority, linearizable, snapshot",
      },
      {
        label: "Failure",
        left: "Stale data from a lagging secondary",
        right: "Provisional data that can be rolled back",
      },
      {
        label: "Together",
        left: "Chooses the path",
        right: "Sets the visibility guarantee on that path",
      },
    ],
  },
  {
    type: "p",
    text: "Causal consistency is a third concern. A causally consistent session can read your own writes across members; it is not the same as raising the read concern. If the product needs read-your-writes after a known write, use a causal session with majority read and write concern rather than assuming a primary read is enough.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Rolled-back reads: the share of reads that saw data later removed by failover.",
      "Stale read age: how old the returned view is compared with the primary.",
      "Read p99: the latency cost of waiting for a stronger guarantee.",
      "Read errors: whether the chosen concern can be satisfied during failover.",
      "The primary and new primary roles as the crash and election unfold.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Local read after crash and watch rolled-back reads rise while p99 stays low. Switch the same crash to majority and compare the latency and error behavior. Then apply Linearizable to see the strongest guarantee and its cost.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Read and write concern are a pair",
    body: "A majority read cannot make a `w:1` write durable. If a value must survive failover, use majority write concern so it reaches the majority commit point, and read it with majority concern. Choosing only one side leaves the gap open.",
  },
  { type: "sim", simId: "read-concern" },
  { type: "experiment", experimentId: "predict-rollback" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary crashed with writes that had not reached a majority. Local reads had already returned those writes, so the application acted on data that the new primary would not keep. The read did not fail and the latency stayed low; that was the problem. The guarantee was weaker than the product assumed.",
  },
  {
    type: "p",
    text: "Majority read concern on the same crash removed the rolled-back reads because the read waited for the majority commit point. Linearizable added a primary confirmation and a higher latency cost. The data that was never majority-committed was still lost; the read concern changed whether the application could see it before the loss.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "An order, balance, or inventory value that appears and then disappears after a failover.",
      "Reads that succeed with low latency during the incident, which makes the problem harder to notice.",
      "A write acknowledged with `w:1` and a read using the default local concern.",
      "After failover, a duplicate or missing record that the application cannot explain from its own logs.",
      "Linearizable reads blocking or failing while there is no primary.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the read concern on the query and the write concern on the write that created the value. Then check whether the primary crashed before the write reached a majority. If the read served from a secondary, check replication lag and read preference. Do not start by blaming the election; the election only revealed a visibility choice.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify the read: provisional, decision-grade, or read-your-writes.",
      "Use majority read and write concern for decision-grade data.",
      "Use a causal session when the application must read its own writes across members.",
      "Reserve linearizable reads for the rare cases that need them, with a unique filter and `maxTimeMS`.",
      "Set a bounded retry for reads that fail during failover.",
      "Test the pair of concerns in a failover drill, not only in normal operation.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Local is the lowest-latency choice and the one most likely to return provisional data.",
      "Majority adds a wait for the commit point but survives a primary crash.",
      "Linearizable is the strongest guarantee and the most expensive; it is primary-only and needs a unique filter.",
      "Snapshot gives a stable view but is limited outside transactions and can be stale relative to the newest write.",
      "A causal session gives read-your-writes without making every read linearizable.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "local-rollback",
    question: "How can a read return data that is later rolled back?",
    difficulty: 3,
    hints: [
      "Start with what local guarantees.",
      "A primary crash can discard unreplicated writes.",
      "Read preference is not read concern.",
    ],
    answer:
      "With local read concern, the query returns the most recent data on the member it reaches, without waiting for a majority. If a write was acknowledged by only the primary and the primary crashes before replication, a new primary can roll it back. The local read already returned it, so the application saw data that did not survive. Primary read preference does not prevent this because it only chooses the member.",
    followUps: [
      "What write concern would prevent the loss?",
      "How does majority read concern change the read?",
      "What role does a causal session play?",
    ],
    redFlags: [
      "Blames read preference alone.",
      "Says the write was durable because the primary acknowledged it.",
      "Confuses local with majority.",
    ],
    rubric: [
      "Explains local visibility.",
      "Explains rollback after crash.",
      "Separates read preference from read concern.",
      "Pairs with write concern.",
    ],
  },
  {
    id: "levels",
    question: "Compare local, majority, linearizable, and snapshot read concern.",
    difficulty: 3,
    hints: [
      "State the guarantee first.",
      "Linearizable has operational requirements.",
      "Snapshot is mostly a transaction concern.",
    ],
    answer:
      "Local returns the newest data on the member and may be rolled back. Majority returns data acknowledged by a majority and is durable across failover, at the cost of waiting for the commit point. Linearizable reads reflect all majority-acknowledged writes that completed before the read, run only on the primary, and may be much slower; the guarantee needs a unique filter and `maxTimeMS` during unavailability. Snapshot returns majority-committed data from one point in time, mostly used inside transactions.",
    followUps: [
      "Which level works on a secondary?",
      "When would majority be enough instead of linearizable?",
      "What does snapshot guarantee across shards?",
    ],
    redFlags: [
      "Treats all levels as latency settings.",
      "Says linearizable works on a secondary.",
      "Ignores the unique-filter requirement.",
    ],
    rubric: [
      "States each guarantee.",
      "Mentions durability.",
      "Notes linearizable constraints.",
      "Places snapshot correctly.",
    ],
  },
  {
    id: "choose",
    question: "How do you choose a read concern for a payment status page and for a product feed?",
    difficulty: 3,
    hints: [
      "Start from the consequence of a wrong read.",
      "A feed can tolerate staleness.",
      "A payment decision cannot tolerate a rollback.",
    ],
    answer:
      "A payment status read drives an irreversible decision, so I would use majority read concern with majority write concern, and a causal session if the user must see their own update. A product feed can use local or a secondary read preference because a slightly stale or even rolled-back item is acceptable. I would document the choice and test it during failover, rather than applying one default everywhere.",
    followUps: [
      "Where would linearizable be justified?",
      "How would you test the choice?",
      "What if the payment page also needs low latency?",
    ],
    redFlags: [
      "Uses local for payments because it is faster.",
      "Uses linearizable for every read.",
      "Ignores the write concern.",
    ],
    rubric: [
      "Starts from consequence.",
      "Pairs read and write concern.",
      "Mentions causal sessions.",
      "Tests under failover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Read concern is chosen per use case, not left at a single global default without review.",
      "Decision-grade reads use majority read and majority write concern.",
      "Read-your-writes paths use a causal session.",
      "Linearizable reads have a unique filter and `maxTimeMS`.",
      "Failover drills verify both visibility and durability, not only availability.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the read concern on the query and the write concern on the write.",
      "Check whether the primary crashed before the write reached a majority.",
      "Check replication lag if the read was served by a secondary.",
      "Do not raise read concern alone to fix a write that was never durable.",
      "Watch for reads that succeed during failover; success is not proof of durability.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Identify the data that was rolled back and reconcile it with the application.",
      "Review the read and write concern pair for that path.",
      "Add a causal session if the application must read its own writes.",
      "Test the corrected pair in a failover drill.",
    ],
  },
];

const references = [
  {
    title: "Read Concern",
    url: "https://www.mongodb.com/docs/manual/reference/read-concern/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Local, majority, linearizable, and snapshot levels, including availability and performance notes.",
  },
  {
    title: "Read Isolation, Consistency, and Recency",
    url: "https://www.mongodb.com/docs/manual/core/read-isolation-consistency-recency/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Causal consistency, read-your-writes, and the relationship between read and write concern.",
  },
  {
    title: "Write Concern",
    url: "https://www.mongodb.com/docs/manual/reference/write-concern/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "How write concern determines what reaches the majority commit point before a read can see it.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-concern": {
      model: readConcernModel,
      presets,
      instructions:
        "Start Healthy, then apply Local read after crash. Watch rolled-back reads rise while latency stays low. Switch the crash to majority and compare, then apply Linearizable.",
      experimentIds: [experiment.id],
      alternateVisuals: ["replication"],
      note: "Illustrative model. Lag, rollback percentages, and latency are teaching values; MongoDB's documented guarantee is that local data may be rolled back and majority data is durable.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-write-concern", "mongodb-read-preference", "mongodb-replica-set"],
};
