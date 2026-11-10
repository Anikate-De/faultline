import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "primaryAvailable",
    label: "Primary region available",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scenario",
    help: "1 means the primary is healthy, so a planned switchover can wait for sync. 0 models an unplanned regional failure.",
    format: "count" as const,
  },
  {
    id: "replicaLag",
    label: "Replica lag",
    min: 0,
    max: 300,
    step: 1,
    value: 1,
    unit: "s",
    group: "Replication",
    help: "How far the secondary is behind the primary at the moment of failover. This is the RPO exposure.",
    format: "number" as const,
  },
  {
    id: "writeRate",
    label: "Primary write rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 2_000,
    unit: " writes/s",
    group: "Workload",
    help: "Sustained committed writes. Lost writes are estimated as write rate times lag.",
    format: "rps" as const,
  },
  {
    id: "rpoTarget",
    label: "Stated RPO",
    min: 5,
    max: 300,
    step: 5,
    value: 60,
    unit: "s",
    group: "Policy",
    help: "The maximum data loss the business accepts. Compare the promotion loss against this before you promote.",
    format: "number" as const,
  },
  {
    id: "cutoverMinutes",
    label: "Detection and cutover",
    min: 1,
    max: 60,
    step: 1,
    value: 12,
    unit: " min",
    group: "Recovery",
    help: "Minutes from failure detection to application writes on the promoted cluster. Illustrative RTO input.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  primaryAvailable: boolean;
  lag: number;
  writeRate: number;
  rpoTarget: number;
  cutover: number;
  lostWrites: number;
  rpoOverrun: number;
  rto: number;
  replicaHealth: Health;
}

function compute(p: Params): Computed {
  const primaryAvailable = num(p, "primaryAvailable", 1) >= 0.5;
  const lag = clamp(num(p, "replicaLag", 1), 0, 300);
  const writeRate = Math.max(0, num(p, "writeRate", 2_000));
  const rpoTarget = Math.max(1, num(p, "rpoTarget", 60));
  const cutover = Math.max(0, num(p, "cutoverMinutes", 12));
  const lostWrites = primaryAvailable ? 0 : Math.round(writeRate * lag);
  const rpoOverrun = primaryAvailable ? 0 : Math.max(0, lag - rpoTarget);
  const rto = primaryAvailable ? cutover + lag / 60 : cutover;
  const replicaHealth: Health = primaryAvailable
    ? lag > rpoTarget
      ? "warn"
      : "ok"
    : lag > rpoTarget
      ? "crit"
      : lag > rpoTarget / 2
        ? "warn"
        : "ok";
  return {
    primaryAvailable,
    lag,
    writeRate,
    rpoTarget,
    cutover,
    lostWrites,
    rpoOverrun,
    rto,
    replicaHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatSeconds(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}s`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["rpo-overrun", values.rpoOverrun, 0.2],
    ["lost-writes", values.lostWrites, 0],
    ["rto", values.rto, 0.15],
    ["replica-lag", values.lag, 0.15],
    ["write-rate", values.writeRate, 40],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "lost-writes"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "primary",
        label: "Primary · us-east-1",
        kind: "db",
        role: "primary",
        health: values.primaryAvailable ? "ok" : "down",
        utilization: clamp(values.writeRate / 20_000),
        sublabel: values.primaryAvailable
          ? `${formatCount(values.writeRate)} writes/s`
          : "unavailable · promotion required",
        detail: values.primaryAvailable
          ? "The primary is reachable. A planned switchover can wait for the secondary to synchronize, giving RPO 0."
          : "The primary Region is unavailable. Replication has stopped at the secondary's last received point; promotion does not wait for the missing writes.",
        meta: { lag: 0 },
      },
      {
        id: "replica",
        label: "Secondary · us-west-2",
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: clamp(values.lag / Math.max(1, values.rpoTarget)),
        sublabel: `${formatSeconds(values.lag)} behind · RPO ${values.rpoTarget}s`,
        detail: values.primaryAvailable
          ? "A planned switchover will synchronize this secondary before promotion. Lag increases the wait, not the data loss."
          : `This secondary is consistent at a point ${formatSeconds(values.lag)} behind the primary. Promotion discards commits after that point.`,
        meta: { lag: values.lag, rpo: values.rpoTarget },
      },
    ],
    edges: [
      edge(
        "primary-replica",
        "primary",
        "replica",
        clamp(1 - values.lag / 300),
        values.primaryAvailable ? "ok" : "crit",
        "storage replication",
      ),
    ],
    metrics: [
      metric("rpo-overrun", "Promotion loss beyond RPO", values.rpoOverrun, "s", 1, 5, "number"),
      metric("lost-writes", "Unreplicated writes", values.lostWrites, " writes", undefined, undefined, "rps"),
      metric("rto", "Recovery time (RTO)", values.rto, " min", 15, 30, "number"),
      metric("replica-lag", "Replica lag", values.lag, "s", undefined, undefined, "number"),
      metric("write-rate", "Primary write rate", values.writeRate, " writes/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.primaryAvailable
      ? `Planned switchover: ${formatSeconds(values.lag)} lag, RPO 0, RTO ${values.rto.toFixed(1)} min.`
      : `${formatSeconds(values.lag)} lag; about ${formatCount(values.lostWrites)} writes at risk; RPO ${values.rpoTarget}s; RTO ${values.rto.toFixed(1)} min.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rpo-overrun",
    metricId: "rpo-overrun",
    warn: 1,
    crit: 5,
    title: "Promotion would exceed the stated RPO",
    cause:
      "Asynchronous replication leaves the secondary behind the primary. An unplanned promotion keeps the secondary's point in time and discards commits after it.",
    fix:
      "Choose a secondary with less lag, wait for catch-up if the primary is reachable, or accept the loss and reconcile from the old primary snapshot and application records.",
    checkFirst: [
      "Compare each secondary's lag with the stated RPO before promoting.",
      "Choose the secondary with the least lag when more than one exists.",
      "Check whether a failover snapshot of the old primary is available for reconciliation.",
    ],
  },
  {
    id: "rto",
    metricId: "rto",
    warn: 15,
    crit: 30,
    title: "Cutover RTO exceeds the recovery target",
    cause:
      "Detection, promotion, DNS, and application cutover all sit inside the RTO. A correct promotion can still miss the business target.",
    fix:
      "Automate detection and cutover, lower the DNS TTL, pre-scale the secondary, and rehearse the runbook before the incident.",
    checkFirst: [
      "Measure detection time separately from promotion time.",
      "Check the DNS TTL and whether applications use the global writer endpoint.",
      "Check whether the application can warm up and serve writes immediately.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const rpoModel: SimModel = {
  id: "databases-cross-region-rpo",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const defaultsValue = defaults();
    const frame = buildFrame(defaultsValue, seed);
    seedSeries(frame, compute(defaultsValue), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (!values.primaryAvailable && frame.flags.primaryDownLogged !== 1) {
      const withinRpo = values.rpoOverrun === 0;
      pushEvent(next, {
        id: "primary-region-failed",
        severity: withinRpo ? "warn" : "crit",
        title: withinRpo ? "Primary region failed; promotion within RPO" : "Primary region unavailable",
        detail: withinRpo
          ? `Promotion would discard about ${formatCount(values.lostWrites)} writes, inside the ${
              values.rpoTarget
            }s RPO. Those writes still need reconciliation.`
          : `Promotion would discard about ${formatCount(values.lostWrites)} writes, ${formatCount(
              values.rpoOverrun,
            )}s beyond the ${values.rpoTarget}s RPO.`,
        nodeId: "primary",
        metricId: "rpo-overrun",
      });
    }
    next.flags.primaryDownLogged = values.primaryAvailable ? 0 : 1;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = values.primaryAvailable
      ? `Planned switchover: ${formatSeconds(values.lag)} lag, RPO 0, RTO ${values.rto.toFixed(1)} min.`
      : `${formatSeconds(values.lag)} lag; about ${formatCount(values.lostWrites)} writes at risk; RPO ${values.rpoTarget}s; RTO ${values.rto.toFixed(1)} min.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.primaryAvailable) {
      items.push(
        `The primary is reachable, so a planned switchover waits for synchronization and has RPO 0. The ${formatSeconds(
          values.lag,
        )} lag adds about ${(values.lag / 60).toFixed(1)} minutes to the cutover.`,
      );
      items.push(
        `If the primary fails instead of switching over, the same lag becomes a data-loss window of about ${formatCount(
          values.writeRate * values.lag,
        )} writes.`,
      );
    } else if (values.rpoOverrun > 0) {
      items.push(
        `Promotion now would discard about ${formatCount(values.lostWrites)} writes, ${formatCount(
          values.rpoOverrun,
        )}s beyond the ${values.rpoTarget}s RPO.`,
      );
    } else {
      items.push(
        `Lag is inside the ${values.rpoTarget}s RPO. Promotion would discard about ${formatCount(
          values.lostWrites,
        )} writes; the budget accepts that loss, but those writes still need reconciliation.`,
      );
    }
    items.push(
      `The estimate is write rate times lag. The real loss depends on the writes in that window, not on the average rate.`,
    );
    if (!values.primaryAvailable && values.lostWrites > 0) {
      items.push(
        "After promotion, reconcile from the old primary's failover snapshot if it exists, application logs, and idempotency records.",
      );
    }
    items.push(
      `RTO is ${values.rto.toFixed(1)} min. It is separate from data loss; a fast promotion can still lose more than the stated RPO.`,
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
    description: "Primary available, secondary one second behind, well inside the 60-second RPO.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak writes",
    description: "High write rate and 20 seconds of lag. A planned switchover still has RPO 0 but a slower cutover.",
    tone: "warn",
    params: defaults({ replicaLag: 20, writeRate: 8_000, cutoverMinutes: 18 }),
  },
  {
    id: "failure",
    label: "Regional failure",
    description: "The primary is unavailable and the secondary is 90 seconds behind a 60-second RPO.",
    tone: "crit",
    params: defaults({ primaryAvailable: 0, replicaLag: 90, rpoTarget: 60, cutoverMinutes: 14 }),
  },
  {
    id: "switchover",
    label: "Planned switchover",
    description: "The primary is healthy. The switchover waits for the 90-second lag and keeps RPO 0.",
    tone: "warn",
    params: defaults({ replicaLag: 90, rpoTarget: 60, cutoverMinutes: 6 }),
  },
  {
    id: "recovery",
    label: "Promoted within RPO",
    description: "The chosen secondary is two seconds behind. Promotion stays inside the RPO and leaves writes to reconcile.",
    tone: "ok",
    params: defaults({ primaryAvailable: 0, replicaLag: 2, rpoTarget: 60, cutoverMinutes: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-rpo-loss",
  title: "Predict the data loss at promotion",
  simId: "cross-region-failover",
  question:
    "The primary fails with 90 seconds of replication lag at 2,000 writes per second. You promote the secondary. About how many writes are lost, and what happens to the stated 60-second RPO?",
  prediction: {
    options: [
      { id: "no-loss", label: "Zero writes; the secondary is transactionally consistent." },
      { id: "180k", label: "About 180,000 writes; the 60-second RPO is exceeded." },
      { id: "2k", label: "About 2,000 writes; one second of writes." },
      { id: "120k", label: "About 120,000 writes; the write rate times the RPO." },
    ],
    correctOptionId: "180k",
    explanation:
      "Lost writes are approximately write rate times lag: 2,000 writes per second times 90 seconds, or 180,000 writes. The replica is consistent at its own point, but it never received the last 90 seconds of commits. The 60-second RPO is exceeded by 30 seconds.",
  },
  setup: defaults({
    primaryAvailable: 0,
    replicaLag: 90,
    writeRate: 2_000,
    rpoTarget: 60,
    cutoverMinutes: 14,
  }),
  runFor: 20,
  observe: [
    "Promotion loss beyond RPO is 30 seconds and crosses the critical threshold.",
    "Unreplicated writes show about 180,000, the population that needs reconciliation.",
    "Replica lag stays at 90 seconds; the secondary is consistent at a point, not a partial transaction.",
    "RTO is 14 minutes, independent of the 90 seconds of data loss.",
    "The primary node is unavailable while the secondary is failing its RPO.",
  ],
  explain:
    "A secondary is a consistent copy at an earlier point in time. Promotion does not replay the missing 90 seconds; those commits are not in the new primary. The loss is write rate times lag. The only zero-loss path is a planned switchover that waits for synchronization, and that requires a healthy primary.",
  fix: defaults({
    primaryAvailable: 0,
    replicaLag: 2,
    writeRate: 2_000,
    rpoTarget: 60,
    cutoverMinutes: 10,
  }),
  debrief:
    "Promoting a secondary with two seconds of lag brings the loss inside the 60-second RPO, but 4,000 writes were still not replicated and still need reconciliation. Zero loss requires the planned switchover path, not a faster unplanned failover.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Recovery point objective (RPO) is the maximum amount of data, measured in time, that a business accepts losing in a disaster. Recovery time objective (RTO) is how long recovery may take. They are different budgets. A failover can be fast and still lose more data than the business accepts.",
  },
  {
    type: "p",
    text: "Aurora Global Database has a primary cluster in one Region and up to 10 read-only secondary clusters in other Regions. Aurora replicates the storage volume asynchronously, with latency typically under a second. In an unplanned failover, a secondary is promoted without waiting for the primary's last writes. The replica is transactionally consistent at its own point, but commits after that point are not there.",
  },
  {
    type: "p",
    text: "The lag at the moment of failure is the data-loss window. Lost writes are approximately write rate times lag. With 2,000 writes per second and 90 seconds of lag, promotion loses about 180,000 writes. That estimate assumes a steady write rate; the real number depends on the traffic in the lag window.",
  },
  {
    type: "p",
    text: "A planned switchover is different. It runs only when the primary and secondaries are healthy, waits for the target secondary to synchronize, and has RPO 0. An unplanned failover has a non-zero RPO measured in seconds. You cannot get the zero-loss guarantee during a regional outage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Writes go to the primary writer. Storage replication carries them to each secondary's storage volume, and read-only instances serve local reads. The application connects through the global writer endpoint, which follows the primary across a switchover or failover. After promotion, the old primary can return as a secondary, and the other secondaries rebuild from the new primary.",
  },
  {
    type: "diagram",
    id: "replica-lag",
    caption:
      "Replication lag is a freshness budget. During an unplanned failover, it becomes the data-loss budget.",
  },
  {
    type: "compare",
    leftTitle: "Planned switchover",
    rightTitle: "Unplanned failover",
    rows: [
      { label: "Waits for sync", left: "Yes", right: "No" },
      { label: "RPO", left: "0", right: "Replication lag at failure" },
      { label: "Requires", left: "Healthy primary and secondaries", right: "A reachable secondary" },
      { label: "Main risk", left: "Longer, coordinated cutover", right: "Lost writes and split-brain" },
    ],
  },
  {
    type: "p",
    text: "The secondary is not a backup in the point-in-time sense. It is a running copy that is behind. Promotion discards the gap; it does not replay it. Aurora attempts a snapshot of the old primary's storage at the point of failure when the old Region recovers, which gives you a place to find missing writes.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replica lag: seconds behind the primary at the moment you evaluate promotion.",
      "Promotion loss beyond the stated RPO: the breach, not just the raw lag.",
      "Unreplicated writes: write rate times lag, the population that needs reconciliation.",
      "RTO: detection, promotion, Domain Name System (DNS) time to live (TTL) and resolution, and application cutover, shown separately from data loss.",
      "A primary-available toggle: planned switchover has RPO 0; unplanned failover does not.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Regional failure: lag is 90 seconds and the stated RPO is 60. Read the lost-writes number before moving the lag slider. Then lower lag below 60, raise the write rate, and switch the primary back to available to see a planned switchover. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Detection and cutover times, write counts, and thresholds are illustrative teaching values, not Aurora guarantees. Aurora documents RTO in the order of minutes and RPO in seconds for unplanned failover.",
  },
  { type: "sim", simId: "cross-region-failover" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 90 seconds of lag and 2,000 writes per second, promotion lost about 180,000 writes. The replica had a consistent copy of the database as of 90 seconds before the failure; it never had the commits after that point. The 60-second RPO was exceeded by 30 seconds.",
  },
  {
    type: "p",
    text: "The RTO was 14 minutes, which is a separate number. A fast promotion does not reduce the data loss, and a slow one does not increase it. If the lag had been 2 seconds, the same promotion would have lost about 4,000 writes, inside the 60-second budget, but those writes would still need reconciliation.",
  },
  {
    type: "p",
    text: "Switching the primary back to available changed the operation, not just the number. A planned switchover waits for synchronization and has RPO 0. The unplanned path cannot wait, because the primary may be gone.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch AuroraGlobalDBRPOLag in milliseconds for each secondary; older Aurora MySQL versions expose AuroraGlobalDBReplicationLag. Read these from the primary cluster.",
      "PostgreSQL: pg_stat_replication on the primary shows write_lag, flush_lag, and replay_lag; the standby's pg_last_wal_replay_lsn and pg_stat_wal_receiver show how far replay has progressed.",
      "Application: write errors, 5xx rates, connection-pool exhaustion, DNS TTL and resolution, and idempotency-key conflicts after cutover.",
      "Aurora events: failover started and completed, write-fencing results, and the rds:unplanned-global-failover snapshot when the old primary recovers.",
      "Data reconciliation: orders, payments, or messages that the application acknowledged but the promoted database does not contain. This is a product workflow, not a database metric.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare lag with the stated RPO before promoting. If multiple secondaries exist, compare their lag and choose the least-lagged one. Then check whether the application can reconcile the gap. A promotion that is fast but outside RPO is still a data-loss incident.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Decide with two numbers: lag versus RPO for data loss, and detection plus cutover versus RTO for downtime.",
      "For Aurora PostgreSQL, use the `rds.global_db_rpo` parameter when you need a hard RPO bound; it pauses commits when every secondary is behind the target, so measure the write-latency cost before relying on it.",
      "If the primary is reachable, prefer a planned switchover; it waits for sync and has RPO 0.",
      "If the primary is gone, choose the secondary with the least lag, stop writes to the old primary, and promote.",
      "Lower DNS TTLs and use the global writer endpoint so the application follows the new primary. Watch for split-brain if the old primary is still reachable.",
      "After promotion, rebuild the other secondaries from the new primary. This can take minutes to hours depending on volume size and distance.",
      "Reconcile the gap: restore the old primary's failover snapshot if it exists, compare application logs and idempotency records, and replay or compensate. Do not assume the database gap is the whole gap.",
      "Fail back with a planned switchover after the old Region is healthy; do not fail back under pressure.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Waiting for lag reduces data loss but lengthens RTO. During a regional outage, the primary may not be reachable, so waiting is not an option.",
      "Synchronous replication lowers RPO but adds commit latency and can reduce availability when a standby is slow or unreachable.",
      "A planned switchover is zero-loss but needs a healthy primary and a coordinated cutover; it is not a disaster recovery mechanism.",
      "Reconciliation is bounded by what the application recorded. If the write was acknowledged but not logged with an idempotency key, finding it after promotion is hard.",
      "Multi-region active-active can reduce RTO but introduces conflict resolution and a more complex consistency model.",
      "A snapshot of the old primary is useful only if it is retained; backup retention applies.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "decide-failover",
    question:
      "Replica lag is 90 seconds, the stated RPO is 60 seconds, and the primary is unavailable. Do you fail over, and what do you tell the business?",
    difficulty: 3,
    hints: [
      "Calculate data loss before making the call.",
      "Separate the loss already committed from the downtime you avoid.",
    ],
    answer:
      "I would calculate the loss first: 2,000 writes per second times 90 seconds is about 180,000 writes, 30 seconds beyond the stated RPO. That is a breach, so the decision is not purely technical; it is a business call about accepting the loss versus extending the outage. If another secondary has less lag, I would choose it. If failover is still the right call, I would promote, stop writes to the old primary, and start reconciliation from the old primary's failover snapshot, application logs, and idempotency records. I would state the expected loss and the reconciliation plan in the incident channel before promotion.",
    followUps: [
      "What would make you wait instead?",
      "How would two secondaries change the decision?",
      "What do you do if the snapshot is unavailable?",
    ],
    redFlags: [
      "Fails over without quantifying the loss.",
      "Assumes promotion replays the missing writes.",
      "Ignores the reconciliation workload.",
    ],
    rubric: [
      "Calculates write rate times lag.",
      "Compares the result with the stated RPO.",
      "Chooses the least-lagged secondary.",
      "Names reconciliation and split-brain controls.",
    ],
  },
  {
    id: "switchover-vs-failover",
    question: "Why does a planned switchover have RPO 0 while an unplanned failover does not?",
    difficulty: 2,
    hints: [
      "One operation waits for synchronization.",
      "The other assumes the primary may be gone.",
    ],
    answer:
      "A planned switchover runs only when the primary and secondaries are healthy. It waits for the target secondary to synchronize before it changes roles, so no committed transaction is left behind and RPO is 0. An unplanned failover is used when the primary is unavailable or failing; it promotes the secondary at whatever point it has reached, without waiting for the missing writes. That is why the unplanned RPO is bounded by replication lag rather than zero.",
    followUps: [
      "What happens to the old primary after each operation?",
      "When can a switchover not be used?",
      "What does RPO 0 cost in cutover time?",
    ],
    redFlags: [
      "Says failover is always zero-loss.",
      "Ignores the healthy-primary requirement.",
      "Confuses RPO with RTO.",
    ],
    rubric: [
      "Explains the synchronization wait.",
      "States the healthy-primary precondition.",
      "Connects unplanned RPO to lag.",
      "Keeps RPO and RTO distinct.",
    ],
  },
  {
    id: "measure-lag",
    question: "How do you measure replication lag for Aurora Global Database and for PostgreSQL?",
    difficulty: 3,
    hints: [
      "Aurora publishes a metric per secondary.",
      "PostgreSQL exposes WAL sender and receiver state.",
    ],
    answer:
      "For Aurora Global Database I would read AuroraGlobalDBRPOLag in milliseconds for each secondary in CloudWatch; older Aurora MySQL versions use AuroraGlobalDBReplicationLag. I would read it from the primary cluster and compare the value with the RPO. For PostgreSQL, pg_stat_replication on the primary exposes write_lag, flush_lag, and replay_lag, and the standby exposes pg_last_wal_replay_lsn and pg_stat_wal_receiver. I would also compare pg_current_wal_lsn on the primary with the standby's receive and replay positions, because a time-based lag can look small while a large WAL gap is still pending.",
    followUps: [
      "Which lag matters for read freshness?",
      "Which lag matters for failover data loss?",
      "Why can a time-based lag be misleading?",
    ],
    redFlags: [
      "Uses only CPU or replication thread status.",
      "Confuses write lag with replay lag.",
      "Ignores per-secondary values.",
    ],
    rubric: [
      "Names AuroraGlobalDBRPOLag or the older metric.",
      "Names pg_stat_replication lag columns.",
      "Distinguishes write, flush, and replay.",
      "Compares against the RPO.",
    ],
  },
  {
    id: "reconcile",
    question: "Promotion succeeded but 180,000 writes were never replicated. How do you reconcile them?",
    difficulty: 4,
    hints: [
      "The database gap is not the only gap.",
      "A failover snapshot may exist.",
    ],
    answer:
      "I would start by bounding the population: the lag window, the write rate, and the application records that were acknowledged in that window. If Aurora created the rds:unplanned-global-failover snapshot of the old primary, I would restore it in an isolated environment and diff the affected tables or keys against the new primary. In parallel I would use application logs, outbox tables, and idempotency keys to find writes that were acknowledged but are missing. Then I would replay safe operations idempotently or compensate the ones that cannot be replayed. I would not assume the database gap is the whole gap, because a write can fail after the database commit or before the client receives the acknowledgment.",
    followUps: [
      "How do you avoid duplicate side effects during replay?",
      "What if the old primary never returns?",
      "Which records do you reconcile first?",
    ],
    redFlags: [
      "Assumes the replica has all committed writes.",
      "Replays without idempotency.",
      "Ignores application-level acknowledgments.",
    ],
    rubric: [
      "Bounds the loss window.",
      "Uses the failover snapshot when available.",
      "Uses application logs and idempotency keys.",
      "Plans replay or compensation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "RPO and RTO are written down per data class and per Region.",
      "Lag alerts compare each secondary with the RPO, not with a generic threshold.",
      "The failover runbook names the least-lag secondary and the promotion command.",
      "DNS TTL and the global writer endpoint are tested for fast cutover.",
      "A reconciliation plan exists for writes acknowledged but not replicated.",
      "For Aurora PostgreSQL, the `rds.global_db_rpo` setting and its write-latency cost are understood.",
      "Failover snapshots and their retention are understood.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read lag for every secondary before choosing one.",
      "Calculate expected loss as write rate times lag and compare it with the RPO.",
      "Stop writes to the old primary and watch for split-brain.",
      "Promote, verify the new writer, and confirm the application can write.",
      "Record the loss window and start reconciliation immediately.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Rebuild the other secondaries from the new primary.",
      "Reconcile the gap and verify the affected business records.",
      "Fail back with a planned switchover, not another unplanned event.",
      "Update the RPO, runbook, and lag alarms with what you learned.",
    ],
  },
];

const references = [
  {
    title: "Using Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Primary and secondary clusters, asynchronous storage replication, and typical latency under a second.",
  },
  {
    title: "Switchover or failover in Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Unplanned failover RPO, planned switchover RPO 0, write fencing, and the failover snapshot.",
  },
  {
    title: "Disaster Recovery of Workloads on AWS",
    url: "https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "RTO and RPO definitions and DR strategy selection.",
  },
  {
    title: "PostgreSQL: Log-Shipping Standby Servers",
    url: "https://www.postgresql.org/docs/current/warm-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Asynchronous streaming replication and the data-loss window at failover.",
  },
  {
    title: "PostgreSQL: pg_stat_replication",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Write-ahead log (WAL) sender state and the write, flush, and replay lag columns.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cross-region-failover": {
      model: rpoModel,
      presets,
      instructions:
        "Start healthy, apply Regional failure, then compare lag, lost writes, and RTO. Toggle the primary back to available to see the planned-switchover path.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Detection and cutover times and thresholds are teaching values, not Aurora guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-aurora-global",
    "databases-primary-replica-lag",
    "databases-failover-dns",
    "databases-dr-drills",
    "databases-split-brain",
  ],
};
