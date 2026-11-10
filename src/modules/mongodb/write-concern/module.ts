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

const PRIMARY_CAPACITY = 20_000;
const MAX_WRITES = 25_000;
const FAILOVER_SECONDS = 2;
const MODE_NAMES = ["w:1", "w:2", "w:majority"];

const params: ParamSpec[] = [
  {
    id: "writeRate",
    label: "Write rate",
    min: 500,
    max: 25_000,
    step: 500,
    value: 5_000,
    unit: " writes/s",
    group: "Traffic",
    help: "Acknowledged writes per second. Higher rates mean more writes can be exposed during a failover window.",
    format: "rps",
  },
  {
    id: "wMode",
    label: "Write concern",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Durability",
    help: "0 = w:1, 1 = w:2, 2 = w:majority. Numeric write concern counts data-bearing members; majority is calculated from the voting configuration.",
    format: "count",
  },
  {
    id: "journal",
    label: "Journal acknowledgment",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Durability",
    help: "1 adds an explicit j:true wait for the on-disk journal. With w:majority, MongoDB may already wait for journaling depending on `writeConcernMajorityJournalDefault`; this model shows the explicit cost.",
    format: "count",
  },
  {
    id: "secondariesAvailable",
    label: "Secondaries available",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "Data-bearing secondaries that can acknowledge. A write concern larger than the available data-bearing members cannot be satisfied.",
    format: "count",
  },
  {
    id: "primaryLost",
    label: "Primary node lost",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 removes the primary before its most recent acknowledged writes reach a secondary. A new primary takes over after a short interval if a secondary is available.",
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
  writeRate: number;
  mode: number;
  modeName: string;
  journal: boolean;
  secondaries: number;
  lost: boolean;
  inFailover: boolean;
  canAck: boolean;
  required: number;
  dataBearing: number;
  writablePrimary: boolean;
  writeErrorRate: number;
  lostWrites: number;
  ackCopies: number;
  writeP99: number;
  primaryCpu: number;
  replicaLag: number;
}

function compute(p: Params, elapsed: number): Computed {
  const writeRate = clamp(num(p, "writeRate", 5_000), 0, MAX_WRITES);
  const mode = Math.round(clamp(num(p, "wMode", 2), 0, 2));
  const journal = num(p, "journal", 1) >= 0.5;
  const secondaries = Math.round(clamp(num(p, "secondariesAvailable", 2), 0, 2));
  const lost = num(p, "primaryLost", 0) >= 0.5;
  const inFailover = lost && elapsed < FAILOVER_SECONDS;
  const dataBearing = lost ? secondaries : 1 + secondaries;
  const required = mode === 0 ? 1 : 2;
  const writablePrimary = !lost || secondaries >= 1;
  const canAck = writablePrimary && dataBearing >= required && secondaries >= (required - 1);
  const writeErrorRate = canAck ? (inFailover ? 100 : 0) : 100;
  const replicaLag = lost ? 0.2 : 0.1 + (writeRate / 20_000) * 1.2;
  const lostWrites = lost && mode === 0 ? writeRate * replicaLag : 0;
  const ackCopies = canAck ? (lost ? (mode === 0 ? 0 : 1) : required) : 0;

  const base = 1.5 + (writeRate / 20_000) * 5;
  const ackNetwork = (required - 1) * 1.5;
  const journalWait = journal ? 5 : 0;
  const writeP99 = canAck && !inFailover ? base + ackNetwork + journalWait : 2_000;
  const primaryCpu = lost ? 0 : clamp((writeRate / PRIMARY_CAPACITY) * 100, 0, 120);

  return {
    writeRate,
    mode,
    modeName: MODE_NAMES[mode],
    journal,
    secondaries,
    lost,
    inFailover,
    canAck,
    required,
    dataBearing,
    writablePrimary,
    writeErrorRate,
    lostWrites,
    ackCopies,
    writeP99,
    primaryCpu,
    replicaLag,
  };
}

function cpuHealth(value: number): Health {
  if (value >= 90) return "crit";
  if (value >= 75) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const clientHealth: Health =
    values.writeErrorRate >= 10 ? "crit" : values.writeErrorRate >= 1 ? "warn" : "ok";
  const oldPrimaryHealth: Health = values.lost
    ? "down"
    : cpuHealth(values.primaryCpu);
  const secondaryAHealth: Health = values.lost
    ? values.secondaries >= 1
      ? values.inFailover
        ? "warn"
        : "ok"
      : "down"
    : values.secondaries >= 1
      ? "ok"
      : "down";
  const secondaryBHealth: Health = values.secondaries >= 2 ? "ok" : "down";
  const newPrimary = values.lost && values.secondaries >= 1;

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: clientHealth,
      sublabel:
        values.writeErrorRate > 0
          ? `${values.writeErrorRate.toFixed(0)}% writes failing`
          : `${values.modeName} · p99 ${values.writeP99.toFixed(0)}ms`,
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: newPrimary ? "Old primary" : "Primary",
      kind: "db",
      role: newPrimary ? "replica" : "primary",
      health: oldPrimaryHealth,
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.lost ? 0 : values.writeRate,
      sublabel: values.lost
        ? values.writablePrimary
          ? "node lost · data on disk unreachable"
          : "node lost · no replacement"
        : `${values.writeRate.toLocaleString()} writes/s · ${values.primaryCpu.toFixed(0)}% CPU`,
      detail:
        "The primary applies each write and records it in its oplog. Acknowledgment depends on write concern and journal settings; a node loss can remove the only copy of a write that was never replicated.",
      meta: { view: "replication", lag: 0 },
    },
    {
      id: "replica-1",
      label: newPrimary ? "New primary" : "Secondary A",
      kind: "db",
      role: newPrimary ? "primary" : "replica",
      health: secondaryAHealth,
      utilization: clamp((values.primaryCpu / 100) * 0.8),
      throughput: values.writeRate,
      sublabel:
        values.secondaries >= 1
          ? newPrimary
            ? values.inFailover
              ? "promoted · write concern pending"
              : `promoted · ${values.modeName}`
            : `acknowledges ${values.mode === 0 ? "no write" : "writes"}`
          : "unavailable",
      detail:
        "A secondary can acknowledge a write only after receiving and applying it. A numeric write concern counts data-bearing members; majority uses the calculated voting majority.",
      meta: { view: "replication", lag: values.replicaLag },
    },
    {
      id: "replica-2",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: secondaryBHealth,
      utilization: clamp((values.primaryCpu / 100) * 0.8),
      throughput: values.secondaries >= 2 ? values.writeRate : 0,
      sublabel: values.secondaries >= 2 ? `lag ${values.replicaLag.toFixed(1)}s` : "unavailable",
      detail:
        "The second data-bearing secondary provides the third copy and another acknowledgment path. Losing enough members can make the requested write concern unsatisfiable.",
      meta: { view: "replication", lag: values.replicaLag },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge(
        "client-primary",
        "client",
        newPrimary ? "replica-1" : "primary",
        values.writeRate / MAX_WRITES,
        clientHealth,
      ),
      edge(
        "primary-replica-1",
        newPrimary ? "replica-1" : "primary",
        newPrimary ? "primary" : "replica-1",
        values.writeRate / MAX_WRITES,
        secondaryAHealth,
      ),
      edge(
        "primary-replica-2",
        newPrimary ? "replica-1" : "primary",
        "replica-2",
        values.writeRate / MAX_WRITES,
        secondaryBHealth,
      ),
    ],
    metrics: [
      metric("lost-writes", "Acknowledged writes lost", Math.round(values.lostWrites), "writes", 1, 100, "count"),
      metric("write-error-rate", "Write failure rate", values.writeErrorRate, "%", 1, 10, "percent"),
      metric("write-p99", "Write p99", values.writeP99, "ms", 40, 150, "ms"),
      metric("replica-lag", "Replication lag", values.replicaLag, "s", 2, 5, "number"),
      metric("primary-cpu", "Primary CPU", values.primaryCpu, "%", 75, 90, "percent"),
      metric("ack-copies", "Surviving acknowledged copies", values.ackCopies, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      primaryLost: values.lost ? 1 : 0,
      mode: values.mode,
      secondaries: values.secondaries,
    },
    summary: `${values.modeName} · ${values.writeRate.toLocaleString()} writes/s · p99 ${values.writeP99.toFixed(0)}ms · ${Math.round(values.lostWrites).toLocaleString()} acknowledged writes lost`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 10)) / 2.6);
  const rows: [string, number, number][] = [
    ["lost-writes", values.lostWrites, 0],
    ["write-error-rate", values.writeErrorRate, 0.1],
    ["write-p99", values.writeP99, 0.4],
    ["replica-lag", values.replicaLag, 0.02],
    ["primary-cpu", values.primaryCpu, 0.3],
    ["ack-copies", values.ackCopies, 0],
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
    id: "lost-writes",
    metricId: "lost-writes",
    warn: 1,
    crit: 100,
    title: "Acknowledged writes were lost after failover",
    cause: "The write was acknowledged by the primary without reaching a majority, then the primary was lost before replication. A write concern of `w:1` permits this; journaling on the lost node does not replicate the write.",
    fix: "Use `w:\"majority\"` for writes that must survive a primary failover. Reconcile or replay the lost writes if the application can identify them. Do not treat a journal acknowledgment as replication.",
    checkFirst: [
      "Check the write concern on the affected write path.",
      "Check whether the primary was lost before the write reached a majority.",
      "Check the rollback files and application logs for the lost operations.",
    ],
  },
  {
    id: "write-error-rate",
    metricId: "write-error-rate",
    warn: 1,
    crit: 10,
    title: "Write concern cannot be satisfied",
    cause: "The requested number of acknowledgments exceeds the available data-bearing members, or there is no writable primary. The write blocks until `wtimeout` or fails with a write concern error.",
    fix: "Restore enough data-bearing members to meet the write concern, or choose a concern the remaining topology can satisfy. Do not lower durability silently without recording the decision.",
    checkFirst: [
      "Check `rs.status()` for the number of healthy data-bearing members.",
      "Check the write concern and `wtimeout` on the failing path.",
      "Check whether an arbiter is counted incorrectly as a data-bearing acknowledgment.",
    ],
  },
  {
    id: "write-p99",
    metricId: "write-p99",
    warn: 40,
    crit: 150,
    title: "Write acknowledgment latency is rising",
    cause: "Waiting for more acknowledgments, an explicit journal flush, or a failover adds latency to every write on that path.",
    fix: "Measure the latency cost of the chosen concern and isolate high-durability writes from latency-sensitive ones. Keep the durability requirement explicit rather than lowering it under pressure.",
    checkFirst: [
      "Compare write p99 by write concern and operation type.",
      "Check journal and disk latency on the acknowledging members.",
      "Check whether the primary is near its write capacity.",
    ],
  },
  {
    id: "replica-lag",
    metricId: "replica-lag",
    warn: 2,
    crit: 5,
    title: "Replication lag is widening the exposure window",
    cause: "Acknowledged writes that have not reached a secondary are exposed if the primary fails. Higher write rates lengthen the modeled lag.",
    fix: "Use majority write concern for writes that cannot be lost, and check secondary apply capacity and network throughput. Adding acknowledgments increases durability but can increase latency.",
    checkFirst: [
      "Check `rs.printSecondaryReplicationInfo()`.",
      "Check secondary CPU, disk, and network throughput.",
      "Check whether a single hot write path is producing the lag.",
    ],
  },
];

export const writeConcernModel: SimModel = {
  id: "mongodb-write-concern",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const lost = num(p, "primaryLost", 0) >= 0.5;
    const previousLost = Number(frame.flags.primaryLost ?? 0) === 1;
    const failedAt = lost ? (previousLost ? Number(frame.flags.failedAt ?? 0) : frame.t) : -1;
    const values = compute(p, lost ? frame.t - failedAt : 0);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, failedAt };

    const jitter = rng.between(-0.3, 0.3) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "write-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (lost && !Number(next.flags.lossAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-lost",
        at: frame.t,
        severity: values.mode === 0 ? "crit" : "warn",
        title: values.mode === 0 ? "Acknowledged writes died with the primary" : "Primary lost",
        detail:
          values.mode === 0
            ? `About ${Math.round(values.lostWrites).toLocaleString()} writes were acknowledged by the old primary but never reached a majority. They are not available on the promoted secondary.`
            : "The promoted secondary has the majority-committed writes. Writes resume after the new primary is available.",
        nodeId: "primary",
      });
      next.flags.lossAnnounced = 1;
    }
    if (lost && values.mode === 0 && values.journal && !Number(next.flags.journalAnnounced ?? 0)) {
      pushEvent(next, {
        id: "journal-is-not-replication",
        at: frame.t,
        severity: "warn",
        title: "Journaling did not save the write",
        detail:
          "The journal made the write durable on the old primary, but the node is gone. `j:true` alone does not prevent rollback during a replica set failover.",
      });
      next.flags.journalAnnounced = 1;
    }
    if (lost && values.canAck && !values.inFailover && !Number(next.flags.resumedAnnounced ?? 0)) {
      pushEvent(next, {
        id: "writes-resumed",
        at: frame.t,
        severity: "info",
        title: "Writes resumed on the new primary",
        detail: `The new primary can satisfy ${values.modeName} with ${values.dataBearing} data-bearing members.`,
      });
      next.flags.resumedAnnounced = 1;
    }
    if (!lost && previousLost && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-available",
        at: frame.t,
        severity: "info",
        title: "A writable primary is available",
        detail: "Verify the write concern on every write path and reconcile any acknowledged writes that were rolled back.",
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (!lost) {
      next.flags.lossAnnounced = 0;
      next.flags.journalAnnounced = 0;
      next.flags.resumedAnnounced = 0;
      next.flags.recoveredAnnounced = 0;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const lost = num(p, "primaryLost", 0) >= 0.5;
    const elapsed = lost ? Math.max(0, frame.t - Number(frame.flags.failedAt ?? 0)) : 0;
    const values = compute(p, elapsed);
    const items: string[] = [
      `${values.modeName} requires ${values.required} acknowledgment${values.required === 1 ? "" : "s"} from ${values.dataBearing} available data-bearing member${values.dataBearing === 1 ? "" : "s"}.`,
    ];
    if (values.mode === 0) {
      items.push(
        "`w:1` waits only for the primary. A secondary may have the write, but nothing guarantees it, so a failover can roll the write back.",
      );
    } else {
      items.push(
        "The write waits for a second data-bearing member. That is what makes the acknowledged copy survive the loss of the primary.",
      );
    }
    items.push(
      values.journal
        ? "The journal wait makes the write durable on the acknowledging node's disk. It does not send the write to another node."
        : "No explicit journal wait is modeled. A process crash can still lose a `w:1` write even if the node later restarts.",
    );
    if (lost) {
      items.push(
        values.lostWrites > 0
          ? `${Math.round(values.lostWrites).toLocaleString()} acknowledged writes were only on the lost primary and cannot be read from the promoted secondary.`
          : "No acknowledged writes were lost in this model because a majority held them before the primary disappeared.",
      );
    }
    if (!values.canAck) {
      items.push(
        `The concern cannot be satisfied: ${values.required} acknowledgments are required but only ${values.dataBearing} data-bearing members are available.`,
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
    description: "w:majority with journaling at 5k writes/s. The set can satisfy the concern.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "16k writes/s with majority and journaling. Durability holds; the primary is busy.",
    tone: "warn",
    params: defaults({ writeRate: 16_000, wMode: 2, journal: 1, secondariesAvailable: 2, primaryLost: 0 }),
  },
  {
    id: "failure",
    label: "w:1 node loss",
    description: "The primary is lost before a w:1 write reaches a secondary.",
    tone: "crit",
    params: defaults({ writeRate: 8_000, wMode: 0, journal: 0, secondariesAvailable: 2, primaryLost: 1 }),
  },
  {
    id: "majority",
    label: "Majority survives",
    description: "The same node loss with w:majority and journaling. Data survives; availability still dips.",
    tone: "warn",
    params: defaults({ writeRate: 8_000, wMode: 2, journal: 1, secondariesAvailable: 2, primaryLost: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A primary is available and the application uses majority write concern.",
    tone: "ok",
    params: defaults({ writeRate: 5_000, wMode: 2, journal: 1, secondariesAvailable: 2, primaryLost: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-journal",
  title: "Predict whether journaling saves a write from a node loss",
  simId: "write-concern",
  question:
    "A write uses `w:1` and `j:true`. The primary node is lost before the write reaches a secondary. Is the acknowledged write still available?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. The journal is on disk, so the write survives the failover" },
      { id: "no", label: "No. Journaling is local to the lost node; the write never reached a majority" },
      { id: "maybe", label: "Only if the old primary restarts before the election" },
      { id: "read", label: "The write is lost for writes but still visible to secondary reads" },
    ],
    correctOptionId: "no",
    explanation:
      "`j:true` asks the acknowledging member to write to its on-disk journal. It does not replicate the write to another member. If the primary node is lost, the promoted secondary never had the write, so the write is rolled back. `w:\"majority\"` is what guarantees an acknowledged copy on more than one data-bearing member.",
  },
  setup: defaults({ writeRate: 8_000, wMode: 0, journal: 1, secondariesAvailable: 2, primaryLost: 1 }),
  runFor: 15,
  observe: [
    "The old primary is unavailable and a secondary is promoted.",
    "The lost-writes metric is above zero even though journaling was on.",
    "Write failures occur during the failover, then stop once the new primary can satisfy w:1.",
    "The surviving acknowledged copies count is zero for the lost writes.",
  ],
  explain:
    "Durability and replication are different guarantees. The journal protects against a process or host crash when the disk survives and the node can recover. A replica set failover promotes another member, so a write that only existed on the old node is not there to recover. The majority write concern is the replication guarantee.",
  fix: defaults({ writeRate: 8_000, wMode: 2, journal: 1, secondariesAvailable: 2, primaryLost: 0 }),
  debrief:
    "Use `w:\"majority\"` for writes whose loss would be a correctness incident. Keep journaling on for crash durability, but do not present it as failover protection. Measure the latency cost of majority acknowledgment and isolate high-durability writes from paths that can tolerate a weaker concern. After a failover, reconcile any writes that were acknowledged with a weaker concern.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Write concern tells MongoDB how much acknowledgment a write needs before the driver reports success. A replica-set write can wait for the primary only, for a number of data-bearing members, or for a calculated majority. It can also request that those members write the operation to their on-disk journal before acknowledging.",
  },
  {
    type: "p",
    text: "The acknowledgment is not the same as replication to every member. `w:1` returns after the primary applies the write; a secondary may receive it later or not at all before the primary fails. `w:\"majority\"` waits for enough data-bearing voting members to hold the write, which is what prevents an acknowledged write from being rolled back when a new primary takes over.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "diagram",
    id: "replica-lag",
    caption: "The primary acknowledges according to write concern; secondaries receive the oplog asynchronously.",
  },
  {
    type: "table",
    headers: ["Concern", "Waits for", "Survives primary loss", "Main cost"],
    rows: [
      ["w:1", "Primary applied the write", "Only if a secondary already has it", "Lowest latency, rollback risk"],
      ["w:2", "Primary plus one data-bearing secondary", "Yes in this three-member model", "More latency; not membership-aware"],
      ["w:majority", "Calculated majority of data-bearing voting members", "Yes", "More latency; can be unsatisfiable after member loss"],
      ["j:true", "Required members write to the journal", "Not by itself", "Journal flush latency"],
    ],
  },
  {
    type: "p",
    text: "For a three-member primary-secondary-secondary set, `w:\"majority\"` requires two data-bearing members. In a primary-secondary-arbiter set, the arbiter votes but does not hold data, so majority write concern can require both data-bearing members and become unsatisfiable if one is down. `w:2` counts data-bearing members without recalculating for the voting configuration, which is why it is not a substitute for majority in every topology.",
  },
  {
    type: "p",
    text: "Journaling is a separate axis. `j:true` requests acknowledgment after the write reaches the on-disk journal. With `w:\"majority\"`, MongoDB may already wait for journaling depending on `writeConcernMajorityJournalDefault`, which defaults to true. The important distinction is that `j:true` alone does not prevent rollback during a replica set failover; it only makes the local copy durable.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Acknowledged writes lost: the modeled writes that were only on the failed primary.",
      "Write failure rate: a concern that cannot be satisfied, or a failover with no writable primary.",
      "Write p99: the latency cost of waiting for more acknowledgments or a journal flush.",
      "Replication lag: the exposure window for writes that are not yet on a secondary.",
      "Surviving acknowledged copies: whether the write exists on more than the lost node.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply w:1 node loss. Watch acknowledged writes disappear with the old primary. Apply Majority survives and compare the durability result; the old primary is still down, so availability is still affected. Use the experiment to test your journaling intuition before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Acknowledgment is not immortality",
    body: "A successful write response means the requested members acknowledged the operation. It does not mean every member has it, and it does not mean the write is immune to every failure. Choose the concern from the failure you need to survive.",
  },
  { type: "sim", simId: "write-concern" },
  { type: "experiment", experimentId: "predict-journal" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With `w:1`, the primary acknowledged writes before any secondary was guaranteed to have them. When the primary node was lost, the promoted secondary did not have the most recent operations, so those acknowledged writes were rolled back. Turning on the journal did not change the replication outcome; the journal was on the node that disappeared.",
  },
  {
    type: "p",
    text: "With `w:\"majority\"`, each write waited for a second data-bearing member. The promoted secondary had an acknowledged copy, so the data survived. The failover still caused a brief write outage, and the extra acknowledgment increased latency. Durability improved; availability and latency paid for it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The application sees a write concern error or a rollback after the primary changes.",
      "`rs.status()` shows the new primary and the old member's state.",
      "Rollback files on the old primary contain writes that were never majority-committed.",
      "Write latency rises on paths that wait for more acknowledgments or journal flushes.",
      "Write concern errors can appear while the write itself succeeded on the primary; the concern was not satisfied, but the data may still exist.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the write concern on the affected path, then check whether the failed primary had replicated the write to a majority. Do not assume a journal setting is replication. If the write concern cannot be satisfied, check the number of healthy data-bearing members before lowering it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the writes that were acknowledged and then lost.",
      "Check the write concern and journal settings on that path.",
      "Use `w:\"majority\"` for writes that must survive a primary failover.",
      "Reconcile or replay lost writes from application logs or rollback files.",
      "Measure the latency cost and separate high-durability paths from tolerant ones.",
      "Verify the concern can still be satisfied at peak and after one member loss.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "`w:1` has the lowest latency and the weakest failover guarantee.",
      "`w:majority` protects acknowledged writes but adds a network round trip and can be unsatisfiable when too few members are available.",
      "`j:true` improves local crash durability but does not replicate the write.",
      "Majority with journaling can add a journal flush to the critical path.",
      "A higher write concern reduces data loss risk but can reduce availability during a partial outage.",
      "`wtimeout` returns a concern error but does not undo a write that was already applied.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "ack-vs-durable",
    question: "What does it mean when a MongoDB write returns successfully with w:1?",
    difficulty: 2,
    hints: [
      "One member acknowledged.",
      "The other members replicate asynchronously.",
      "A failover can change which copy survives.",
    ],
    answer:
      "It means the primary applied the write and acknowledged it. It does not mean a secondary received it. If the primary is lost before the write replicates, the promoted secondary may not have it, and the write can be rolled back. For writes that must survive that failure, use majority write concern.",
    followUps: [
      "Does journaling change that?",
      "What does `w:2` add?",
      "How would you detect a rollback after failover?",
    ],
    redFlags: [
      "Says the write is durable on all members.",
      "Confuses acknowledgment with backup.",
      "Thinks journaling replicates the write.",
    ],
    rubric: [
      "Names the primary-only acknowledgment.",
      "Explains asynchronous replication.",
      "Names rollback risk.",
      "Contrasts with majority.",
    ],
  },
  {
    id: "journal",
    question: "A teammate says `j:true` prevents write loss during failover. Are they right?",
    difficulty: 3,
    hints: [
      "Journaling is local to a member.",
      "Failover promotes a different member.",
      "Read the write concern documentation on rollback.",
    ],
    answer:
      "No. `j:true` requests acknowledgment after the write is written to the on-disk journal on the members required by the write concern. It improves durability against a process or host crash when that disk survives. It does not replicate the write to another member. If the primary node is lost and a secondary is promoted, a write that only existed on the old primary is still gone. Only a write concern that requires acknowledgment from other data-bearing members prevents that rollback.",
    followUps: [
      "What does `writeConcernMajorityJournalDefault` change?",
      "When is journaling still valuable?",
      "What happens if the old primary restarts?",
    ],
    redFlags: [
      "Treats the journal as a replica.",
      "Ignores the node-loss case.",
      "Confuses durability with availability.",
    ],
    rubric: [
      "Separates local durability from replication.",
      "Names the failover case.",
      "Recommends majority.",
      "Explains the journal's real benefit.",
    ],
  },
  {
    id: "majority-math",
    question: "How many acknowledgments does w:majority need in a three-member set, and what changes with an arbiter?",
    difficulty: 2,
    hints: [
      "Count voting members first.",
      "Arbiters vote but do not hold data.",
      "The majority is the smaller of two numbers.",
    ],
    answer:
      "In a primary-secondary-secondary set, majority is two data-bearing members: the primary and one secondary. With a primary-secondary-arbiter set, the voting majority is still two, but only two members are data-bearing, so majority write concern can require both the primary and the secondary. If either data-bearing member is down, the concern may be unsatisfiable. That is why a three-data-bearing-member topology is safer for majority writes.",
    followUps: [
      "What does `rs.status()` report as `writeMajorityCount`?",
      "Why can an arbiter not acknowledge a write?",
      "What is the default write concern with an arbiter?",
    ],
    redFlags: [
      "Counts the arbiter as a data copy.",
      "Says majority always means two in every topology.",
      "Ignores availability of data-bearing members.",
    ],
    rubric: [
      "Counts data-bearing voting members.",
      "Explains the arbiter case.",
      "Notes unsatisfiable risk.",
      "Contrasts topology choices.",
    ],
  },
  {
    id: "choose-concern",
    question: "How do you choose write concern for a payment record versus a view counter?",
    difficulty: 3,
    hints: [
      "Start from the cost of losing the write.",
      "Then consider the latency budget.",
      "Not every write needs the same concern.",
    ],
    answer:
      "A payment record needs majority write concern, because an acknowledged write that disappears after failover is a correctness incident. I would also keep journaling on for crash durability and reconcile after any failover. A view counter can tolerate `w:1` if losing a small number of increments is acceptable. The concern should be set per write path, not globally, and the latency cost should be measured rather than assumed.",
    followUps: [
      "How would you handle a mixed workload?",
      "What if majority latency exceeds the product budget?",
      "How do retries interact with write concern?",
    ],
    redFlags: [
      "Uses one concern for every write.",
      "Lowers durability without recording the risk.",
      "Ignores the failover window.",
    ],
    rubric: [
      "Separates correctness-critical writes.",
      "Names majority for payment.",
      "Allows a weaker concern for tolerant writes.",
      "Measures latency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each write path has an explicit write concern and journal setting.",
      "Correctness-critical writes use majority and are tested through a failover.",
      "The team knows the majority count and the data-bearing members for each topology.",
      "Write latency is measured by concern, not only as a global average.",
      "Rollback files and reconciliation procedures are documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the lost writes were acknowledged with a weaker concern.",
      "Check the number of healthy data-bearing members before changing the concern.",
      "Check whether the old primary is returning and rolling back uncommitted writes.",
      "Do not lower durability under pressure without recording the decision.",
      "Watch write latency and write concern errors together.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile or replay writes that were acknowledged and then lost.",
      "Confirm majority writes survive the next controlled failover.",
      "Review the latency cost of the chosen concern at peak.",
      "Document which paths intentionally use a weaker concern and why.",
    ],
  },
];

const references = [
  {
    title: "Write Concern for Replica Sets",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-write-concern/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Acknowledgment behavior for numeric and majority write concerns, plus the rollback warning.",
  },
  {
    title: "Write Concern",
    url: "https://www.mongodb.com/docs/manual/reference/write-concern/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "The `w`, `j`, and `wtimeout` options, majority calculation, and the statement that `j:true` alone does not prevent failover rollback.",
  },
  {
    title: "Rollbacks During Replica Set Failover",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-rollbacks/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Why writes that were not majority-committed can be rolled back after a failover.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "write-concern": {
      model: writeConcernModel,
      presets,
      instructions:
        "Start Healthy, then apply w:1 node loss. Watch acknowledged writes disappear with the old primary. Apply Majority survives and compare. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Capacity, latency, and the failover interval are teaching values. Write concern semantics and the journal limitation follow the MongoDB documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-replica-set", "mongodb-read-preference", "mongodb-elections"],
};
