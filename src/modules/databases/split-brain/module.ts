import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "partition",
    label: "Network partition",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 cuts the link between the two database nodes. Clients on each side may still reach their local node.",
    format: "count" as const,
  },
  {
    id: "quorum",
    label: "Quorum and witness",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Control",
    help: "1 requires a majority or a witness before a node may act as writer. 0 lets each side decide on its own.",
    format: "count" as const,
  },
  {
    id: "fencing",
    label: "Fence the old writer",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Control",
    help: "1 blocks storage or network access for the old writer before promotion. A fence without quorum lacks the authority to decide which side wins.",
    format: "count" as const,
  },
  {
    id: "writeRate",
    label: "Writes per side",
    min: 100,
    max: 5_000,
    step: 100,
    value: 400,
    unit: " writes/s",
    group: "Workload",
    help: "Committed writes each reachable node accepts during the partition. Illustrative teaching value.",
    format: "rps" as const,
  },
  {
    id: "partitionMinutes",
    label: "Partition duration",
    min: 1,
    max: 60,
    step: 1,
    value: 10,
    unit: " min",
    group: "Scenario",
    help: "How long both sides remain reachable from their own clients. Divergence grows with this window.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  partitioned: boolean;
  hasQuorum: boolean;
  fences: boolean;
  dualWriter: boolean;
  dualSeconds: number;
  divergentWrites: number;
  fenceSeconds: number;
  clientErrors: number;
  primaryHealth: Health;
  replicaHealth: Health;
}

function compute(p: Params): Computed {
  const partitioned = num(p, "partition", 0) >= 0.5;
  const hasQuorum = num(p, "quorum", 1) >= 0.5;
  const fences = num(p, "fencing", 1) >= 0.5;
  const writeRate = Math.max(0, num(p, "writeRate", 400));
  const minutes = clamp(num(p, "partitionMinutes", 10), 0, 60);
  const dualWriter = partitioned && !(hasQuorum && fences);
  const dualSeconds = dualWriter ? minutes * 60 : 0;
  const divergentWrites = Math.round(dualSeconds * writeRate);
  const fenceSeconds = !partitioned ? 0 : hasQuorum && fences ? 18 : hasQuorum ? 42 : 65;
  const clientErrors = partitioned && hasQuorum && fences ? Math.round(fenceSeconds * writeRate) : 0;
  const primaryHealth: Health = !partitioned
    ? "ok"
    : dualWriter
      ? "crit"
      : fences
        ? "down"
        : "warn";
  const replicaHealth: Health = !partitioned
    ? "ok"
    : dualWriter
      ? "crit"
      : hasQuorum
        ? "ok"
        : "warn";
  return {
    partitioned,
    hasQuorum,
    fences,
    dualWriter,
    dualSeconds,
    divergentWrites,
    fenceSeconds,
    clientErrors,
    primaryHealth,
    replicaHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["dual-writer-seconds", values.dualSeconds, 0],
    ["divergent-writes", values.divergentWrites, 0],
    ["client-errors", values.clientErrors, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "divergent-writes"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const lagSeconds = values.partitioned ? Math.round(num(p, "partitionMinutes", 10) * 60) : 0;
  return {
    t: 0,
    nodes: [
      {
        id: "node-a",
        label: "Node A · original writer",
        kind: "db",
        role: "primary",
        health: values.primaryHealth,
        utilization: clamp(num(p, "writeRate", 400) / 5_000),
        sublabel: !values.partitioned
          ? "single writer · replication healthy"
          : values.dualWriter
            ? "accepting writes · no authority"
            : values.fences
              ? "fenced · writes stopped"
              : "role unclear · may still write",
        detail: values.dualWriter
          ? "Node A can still reach its own storage and clients. Without quorum plus fencing it has no reliable way to learn that Node B was promoted."
          : values.partitioned
            ? "Fencing cuts the old writer off before promotion. The cost is a hard stop for any traffic still routed here."
            : "One writer, one replication path, and no partition. Nothing to reconcile.",
        meta: { lag: lagSeconds },
      },
      {
        id: "node-b",
        label: "Node B · standby",
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: values.dualWriter ? clamp(num(p, "writeRate", 400) / 5_000) : 0.35,
        sublabel: values.dualWriter
          ? "accepting writes · divergent history"
          : values.hasQuorum
            ? "promoted · single writer"
            : "cannot prove authority",
        detail: values.dualWriter
          ? "Node B also accepts writes. Both histories look valid locally, and no shared sequence or constraint spans the two."
          : "Quorum gives Node B the authority to promote. Fencing makes that authority real for Node A.",
        meta: { lag: lagSeconds },
      },
    ],
    edges: [
      edge(
        "replication",
        "node-a",
        "node-b",
        values.partitioned ? 0.05 : 0.9,
        values.partitioned ? "crit" : "ok",
        "streaming replication",
      ),
    ],
    metrics: [
      metric("dual-writer-seconds", "Dual-writer window", values.dualSeconds, " s", 1, 10, "number"),
      metric("divergent-writes", "Divergent writes", values.divergentWrites, " writes", 5_000, 50_000, "count"),
      metric("client-errors", "Rejected writes", values.clientErrors, " writes", 10_000, 50_000, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: !values.partitioned
      ? "No partition. One writer, healthy replication, zero divergence."
      : values.dualWriter
        ? `Both nodes accept writes for ${values.dualSeconds}s. About ${formatCount(values.divergentWrites)} writes need reconciliation.`
        : `Single writer enforced after ${values.fenceSeconds}s of fencing. ${formatCount(values.clientErrors)} writes were rejected.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "dual-writer",
    metricId: "dual-writer-seconds",
    warn: 1,
    crit: 10,
    title: "Two writers accepted writes",
    cause:
      "A partition removed the replication path while both nodes stayed reachable from their own clients. Quorum decides which side may write; fencing makes the losing side stop.",
    fix:
      "Stop writes on one side, fence the old writer at the storage or network layer, and confirm exactly one node reports itself as primary before reopening traffic.",
    checkFirst: [
      "Ask both nodes whether they are in recovery or accept writes; two primaries is the direct signal.",
      "Check whether the cluster uses a witness or quorum and whether it still has majority.",
      "Check that fencing is configured and tested, not just documented.",
    ],
  },
  {
    id: "divergence",
    metricId: "divergent-writes",
    warn: 5_000,
    crit: 50_000,
    title: "Accepted writes diverged",
    cause:
      "Once both nodes commit independently, the same key can have two valid versions, and unique constraints or sequences may collide. The databases cannot merge this automatically.",
    fix:
      "Freeze both sides, preserve a snapshot of each, then reconcile per business key with an idempotent replay or a deliberate discard policy. Rebuild the losing node from the chosen truth.",
    checkFirst: [
      "Bound the divergence window and the write rate to size the affected population.",
      "Check which tables have unique keys, sequences, or external side effects that a merge would break.",
      "Preserve the losing side before rebuilding it; its writes may be the only record of accepted work.",
    ],
  },
  {
    id: "rejected",
    metricId: "client-errors",
    warn: 10_000,
    crit: 50_000,
    title: "Clients were rejected during fencing",
    cause:
      "A correct single-writer design still fails writes on the losing side. Fencing and promotion take time, and clients without retry or failover handling surface errors.",
    fix:
      "Route clients through a writer endpoint that follows the promoted node, add bounded retries with jitter, and pre-test the failover path so the rejected window is measured rather than discovered.",
    checkFirst: [
      "Confirm clients use the writer endpoint rather than a node address.",
      "Check retry budgets and whether retries are safe for non-idempotent writes.",
      "Measure the fence-to-serve interval, not only the database promotion time.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const splitBrainModel: SimModel = {
  id: "databases-split-brain",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, values, seed);
    pushEvent(frame, {
      id: "cluster-ready",
      at: 0,
      severity: "info",
      title: "Replication current",
      detail: "Two nodes, one writer. Apply a preset or activate the partition to change the scenario.",
      nodeId: "node-a",
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
    }
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.dualWriter && frame.flags.dualLogged !== 1) {
      pushEvent(next, {
        id: "dual-writers",
        severity: "crit",
        title: "Both nodes are accepting writes",
        detail: "Quorum and fencing are not both in place. Every second of this window adds accepted writes that must be reconciled.",
        nodeId: "node-a",
        metricId: "divergent-writes",
      });
    }
    if (values.partitioned && !values.dualWriter && frame.flags.fencedLogged !== 1) {
      pushEvent(next, {
        id: "writer-fenced",
        severity: "warn",
        title: "Single writer enforced",
        detail: `The old writer was fenced after ${values.fenceSeconds}s. ${formatCount(values.clientErrors)} writes were rejected while traffic moved.`,
        nodeId: "node-b",
        metricId: "client-errors",
      });
    }
    next.flags = {
      ...frame.flags,
      ...next.flags,
      dualLogged: values.dualWriter ? 1 : 0,
      fencedLogged: values.partitioned && !values.dualWriter ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (!values.partitioned) {
      items.push("With no partition there is one writer. The controls matter only when the link fails.");
    } else if (values.dualWriter) {
      items.push(
        `Both sides accepted writes for ${values.dualSeconds}s, about ${formatCount(
          values.divergentWrites,
        )} writes. Neither node can prove the other is wrong from local state.`,
      );
      items.push(
        values.hasQuorum
          ? "Quorum picked a side, but without fencing the old writer can keep committing. Authority without enforcement is not a single-writer guarantee."
          : "Without quorum, each side can conclude it is the survivor. Fencing alone cannot settle which one should win.",
      );
    } else {
      items.push(
        `Quorum and fencing produced one writer after ${values.fenceSeconds}s. ${formatCount(
          values.clientErrors,
        )} writes failed rather than diverging; that is the intended trade.`,
      );
    }
    items.push(
      "Divergent writes are a product problem as much as a database problem: unique keys, sequences, payments, and external side effects may not be mergeable.",
    );
    items.push(
      "Recovery order is freeze, snapshot both sides, choose the authoritative history, rebuild the loser, then reconcile by business key.",
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
    description: "No partition. Quorum and fencing are configured but idle, and replication is current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partition, controls on",
    description: "A partition is detected and one side is fenced. Writes fail for 18 seconds, then a single writer serves.",
    tone: "warn",
    params: defaults({ partition: 1, writeRate: 1_500, partitionMinutes: 20 }),
  },
  {
    id: "failure",
    label: "Split brain",
    description: "No quorum and no fencing. Both nodes accept 400 writes per second for 15 minutes.",
    tone: "crit",
    params: defaults({ partition: 1, quorum: 0, fencing: 0, writeRate: 400, partitionMinutes: 15 }),
  },
  {
    id: "quorum-only",
    label: "Quorum without fencing",
    description: "Quorum chooses a side, but the old writer is never fenced and keeps accepting writes.",
    tone: "crit",
    params: defaults({ partition: 1, quorum: 1, fencing: 0, partitionMinutes: 10 }),
  },
  {
    id: "recovery",
    label: "Fenced and recovered",
    description: "Quorum and fencing hold. One writer remains, rejected writes are bounded, and there is nothing to merge.",
    tone: "ok",
    params: defaults({ partition: 1, quorum: 1, fencing: 1, writeRate: 400, partitionMinutes: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-divergence",
  title: "Predict the divergent write population",
  simId: "split-brain",
  question:
    "A partition lasts 10 minutes. Neither node has quorum or fencing, and each side accepts 400 writes per second. About how many writes land outside a shared history?",
  prediction: {
    options: [
      { id: "zero", label: "Zero. The databases reconcile when the link returns." },
      { id: "24k", label: "About 24,000 writes, one minute of traffic." },
      { id: "240k", label: "About 240,000 writes, both sides for the full partition." },
      { id: "all", label: "All writes. The cluster rejects both histories." },
    ],
    correctOptionId: "240k",
    explanation:
      "Divergence is about write rate times the dual-writer window: 400 writes per second times 600 seconds, or 240,000 writes. Reconnecting the link does not merge them. Each write may have a matching key on the other side, and unique constraints, sequences, and external side effects can make automatic merge impossible.",
  },
  setup: defaults({ partition: 1, quorum: 0, fencing: 0, writeRate: 400, partitionMinutes: 10 }),
  runFor: 20,
  observe: [
    "The dual-writer window is 600 seconds and crosses the critical threshold.",
    "Divergent writes are about 240,000 and cross the critical threshold.",
    "Rejected writes stay at zero: both sides accept traffic, which is the dangerous outcome.",
    "Both nodes are failing, each convinced it is a valid writer.",
    "Replication between the nodes has stopped; lag equals the partition duration.",
  ],
  explain:
    "A partition is not a node failure. Each node still has storage, clients, and a plausible claim to be the writer. If neither quorum nor fencing removes that claim, both commit. The databases cannot tell which history is correct because both are locally consistent. Reconnecting replication does not resolve the conflict; it exposes it.",
  fix: defaults({ partition: 1, quorum: 1, fencing: 1, writeRate: 400, partitionMinutes: 10 }),
  debrief:
    "With quorum and fencing, the same partition keeps one writer. The cost moves from reconciliation to rejected writes during the fence window: about 7,200 writes at 400 per second for 18 seconds. That is a bounded, visible failure instead of an unbounded merge problem.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Split brain is a state where two database nodes both accept writes because each believes it is the writer. It is not the same as a failover. A failover moves one writer from A to B. Split brain leaves A and B writing at the same time, with no shared order and no automatic way to merge the results.",
  },
  {
    type: "p",
    text: "A network partition is the usual trigger. The replication link between the nodes fails, but each node can still reach its own storage and its own clients. If the cluster has no quorum, each side can conclude that the other is gone. If it has quorum but does not fence the old writer, the losing side may keep committing because nothing has told it to stop.",
  },
  {
    type: "p",
    text: "Three controls are often mentioned together, but they do different jobs. Quorum or a witness supplies authority: a majority decides which side may act as writer. Fencing supplies enforcement: the old writer loses storage or network access before the new writer is promoted. A single-writer design removes the choice entirely, usually by keeping one writer and making promotion an explicit, coordinated operation.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Applications write through a writer endpoint. The primary sends write-ahead log (WAL) to a standby, which applies it. During a partition the application may still reach both nodes through separate addresses, or through a DNS name that has not converged. That is why client routing matters: a database can be correctly configured and still receive writes on the wrong side.",
  },
  {
    type: "compare",
    leftTitle: "Quorum plus witness",
    rightTitle: "Fencing",
    rows: [
      { label: "Answers", left: "Which side may write", right: "How the other side is stopped" },
      { label: "Prevents", left: "Two sides both claiming authority", right: "A stale writer committing after promotion" },
      { label: "Needs", left: "An odd number of voters or a tie-breaker", right: "Storage, power, or network control" },
      { label: "Fails when", left: "The witness is unreachable too", right: "It is skipped or never tested" },
    ],
  },
  {
    type: "p",
    text: "Managed services usually hide this layer. Amazon RDS Multi-AZ presents one writer endpoint and controls failover; you do not run a two-node election yourself. Self-managed PostgreSQL clusters need an external decision maker such as Patroni with etcd or Consul, plus a fencing mechanism. The lesson is the same: a database cannot safely decide alone that it is the only survivor.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Dual-writer window: seconds during which both nodes accept writes.",
      "Divergent writes: the population accepted without a shared history.",
      "Rejected writes: the bounded cost of enforcing one writer during a partition.",
      "Replication lag: during a partition it grows with the partition duration.",
      "Node state: two failing writers, or one fenced node and one healthy promoted node.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Split brain and read the dual-writer window before touching the sliders. Then turn on quorum only, and notice that the window does not close: authority without enforcement is not enough. Turn on fencing as well, and compare divergent writes with rejected writes. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Write rates, fence times, and thresholds are illustrative teaching values. They are not guarantees for PostgreSQL, Patroni, or Amazon RDS.",
  },
  { type: "sim", simId: "split-brain" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the partition lasted 15 minutes and both nodes accepted 400 writes per second. The dual-writer window was 900 seconds and about 360,000 writes diverged. No client saw an error, which is exactly why this failure is easy to miss: the writes succeeded.",
  },
  {
    type: "p",
    text: "Turning on quorum alone did not close the window. The cluster could decide which side should win, but the old writer was never stopped. Turning on fencing as well produced one writer after 18 seconds. Divergence fell to zero and the cost became about 7,200 rejected writes. That is a bounded failure with a clear owner.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Two nodes report themselves as primary: `pg_is_in_recovery()` returns false on both, or two writers hold the same leader lock.",
      "Replication stops: `pg_stat_replication` is empty on the isolated writer, and the standby's `pg_last_wal_receive_lsn` stops advancing.",
      "Application writes succeed on two different endpoints, or the same key returns different values depending on which node answers.",
      "Constraint and sequence conflicts appear after reconnection: duplicate keys, gaps, or values that jump backward.",
      "Managed failover events show a promotion, while old connections or cached DNS still send a share of writes to the previous writer.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether two nodes accept writes. Then check whether the cluster still has quorum and whether the old writer is fenced. Do not reconnect replication to 'see what happens': that can copy one divergent history over the other and destroy the evidence you need.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop writes on both sides. Remove the writer endpoint from service rather than letting traffic choose a node.",
      "Fence the side that should lose: block its storage access, revoke its network path, or stop the database process.",
      "Preserve a snapshot or clone of each side before any repair. The losing side may hold writes that were acknowledged to users.",
      "Choose the authoritative history using quorum, the furthest durable WAL position, or a business decision. Write the choice down.",
      "Rebuild the losing node from the chosen primary. Do not point it at the old divergent history.",
      "Reconcile accepted writes by business key: replay idempotently where possible, compensate where not, and record every decision.",
      "Reopen traffic through the writer endpoint, verify one primary, and watch for constraint conflicts during the first write burst.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fencing converts silent divergence into visible write errors. That is usually the better failure, but it is still an outage on the losing side.",
      "Quorum reduces the chance of two writers but adds a dependency. If the witness is unreachable, the cluster may refuse writes even though the database is healthy.",
      "Synchronous replication lowers data loss but increases commit latency and can block when a standby is slow.",
      "Automatic reconciliation works only for data with a clear merge rule. Payments, counters, and unique identifiers often need a human decision.",
      "A single-writer design is simpler to reason about but concentrates availability risk in one node and one promotion path.",
      "Testing fencing in production is risky; testing it only in staging leaves the real failure path unproven.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "first-checks",
    question:
      "A partition alert fires. One operator says the old primary is healthy, another says the standby was promoted. What do you check first?",
    difficulty: 4,
    hints: [
      "Start with who can accept writes, not with which node looks healthy.",
      "Authority and enforcement are separate checks.",
    ],
    answer:
      "I would check whether both nodes accept writes: run `pg_is_in_recovery()` on each and look for two nodes reporting primary. Then I would check quorum and fencing: does the cluster still have a majority or witness, and is the old writer actually cut off from storage or clients? I would also check where the writer endpoint resolves and whether any clients use node addresses directly. Until I know there is one writer, I would stop writes rather than reconnect replication, because reconnecting can overwrite one history with the other.",
    followUps: [
      "What if the witness is also unreachable?",
      "How do you tell an old primary from a promoted standby without trusting either?",
      "What does the application see while you decide?",
    ],
    redFlags: [
      "Reconnects replication to see which side wins.",
      "Trusts a single node's self-reported health.",
      "Treats quorum as equivalent to fencing.",
    ],
    rubric: [
      "Checks for two writers directly.",
      "Separates quorum from fencing.",
      "Stops writes before repair.",
      "Preserves evidence on both sides.",
    ],
  },
  {
    id: "quorum-vs-fencing",
    question: "Why is quorum alone not enough to prevent split brain?",
    difficulty: 3,
    hints: [
      "Quorum decides; something else enforces.",
      "The old writer may not hear the decision.",
    ],
    answer:
      "Quorum gives the cluster a way to agree on which side may act as writer, but agreement is not enforcement. The old writer can be partitioned from the voters and still reach its storage and clients. If it is not fenced, it can keep committing after the other side is promoted. Fencing removes that possibility by cutting storage or network access before promotion. The two controls cover different failures: quorum prevents two sides from both claiming authority, fencing prevents a node that lost authority from continuing to write.",
    followUps: [
      "What is a witness and when does it help?",
      "What happens if fencing fails midway?",
      "Can application-level checks replace fencing?",
    ],
    redFlags: [
      "Says quorum stops all writes on the minority side automatically.",
      "Confuses a witness with a backup.",
      "Assumes the old writer will notice the promotion.",
    ],
    rubric: [
      "Defines quorum as authority.",
      "Defines fencing as enforcement.",
      "Explains the isolated old writer.",
      "Names a failure each control does not cover.",
    ],
  },
  {
    id: "reconcile",
    question:
      "Both sides accepted writes for ten minutes. How do you reconcile them without silently losing accepted work?",
    difficulty: 4,
    hints: [
      "Freeze first; do not let either side keep writing.",
      "Not every write can be merged automatically.",
    ],
    answer:
      "I would freeze both sides and preserve a snapshot of each before any repair. Then I would bound the affected population by time window and key range, and classify the writes: idempotent updates that can be replayed, inserts that may collide on unique keys, and operations with external side effects such as payments or emails. I would choose an authoritative history based on quorum, WAL position, or a business rule, rebuild the losing node from it, and replay or compensate the classified writes with an audit record. For conflicts that cannot be merged safely, I would escalate to the owning product team rather than guess.",
    followUps: [
      "How do you handle sequence values that overlap?",
      "What if the losing side has the only copy of a payment?",
      "How do you prove the reconciliation is complete?",
    ],
    redFlags: [
      "Uses last-write-wins for every table.",
      "Rebuilds one side before taking a snapshot.",
      "Replays writes without idempotency keys.",
    ],
    rubric: [
      "Freezes and snapshots both sides.",
      "Classifies writes by merge risk.",
      "Chooses and documents an authority.",
      "Audits replay and compensation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cluster has an odd number of voters or a witness, and the failure of one voter is tested.",
      "Fencing is implemented at storage or network level and has been exercised, not only documented.",
      "Applications use a writer endpoint, not node addresses, and retries are idempotent.",
      "A split-brain runbook names who decides the authoritative side and how both sides are preserved.",
      "Alerts fire on two primaries, stalled replication, and writes split across endpoints.",
      "A reconciliation policy exists per data class, including payments, counters, and unique identifiers.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop writes on both sides before investigating which node is correct.",
      "Confirm quorum state and fence the losing side.",
      "Snapshot or clone both sides before reconnecting anything.",
      "Record the dual-writer window and estimate the divergent population.",
      "Reopen traffic through one writer endpoint and watch constraint conflicts.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile by business key and keep an audit trail of every replay or discard.",
      "Rebuild the losing node from the chosen primary.",
      "Test the fencing path again with the failure that actually occurred.",
      "Update the runbook, alerts, and client routing based on measured timings.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: High Availability, Load Balancing, and Replication",
    url: "https://www.postgresql.org/docs/current/high-availability.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Failover, quorum, and the difference between a standby and an independent writer.",
  },
  {
    title: "PostgreSQL: Log-Shipping Standby Servers",
    url: "https://www.postgresql.org/docs/current/warm-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Primary and standby roles, WAL shipping, and promotion behavior.",
  },
  {
    title: "Amazon RDS: Multi-AZ DB instance deployments",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed single-writer failover with a synchronous standby and a writer endpoint.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "split-brain": {
      model: splitBrainModel,
      presets,
      instructions:
        "Start Healthy, apply Split brain, then add quorum and fencing one at a time. Compare divergent writes with rejected writes.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Write rates, fence times, and thresholds are teaching values, not vendor guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-failover-dns",
    "databases-cross-region-rpo",
    "databases-multi-az-vs-region",
    "databases-primary-replica-lag",
    "databases-dr-drills",
  ],
};
