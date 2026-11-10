import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERVER_SELECTION_BUDGET = 30;

const params: ParamSpec[] = [
  {
    id: "writeRate",
    label: "Write rate",
    min: 1_000,
    max: 30_000,
    step: 1_000,
    value: 8_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Acknowledged writes per second. Retryable writes add driver work during a failover but do not change the application write rate.",
    format: "rps",
  },
  {
    id: "failover",
    label: "Primary failure",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 removes the primary at t=0. The driver must find a new primary before a retry can succeed.",
    format: "count",
  },
  {
    id: "retryableWrites",
    label: "Driver retryable writes",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Retry",
    help: "1 uses the driver's retryable-write path: one retry with the same session and transaction number, so the server can recognize a duplicate attempt.",
    format: "count",
  },
  {
    id: "naiveRetry",
    label: "Application retry",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Retry",
    help: "1 retries the logical operation as a new write, without the original session and transaction number. The server has no way to know it is the same effect.",
    format: "count",
  },
  {
    id: "failoverSeconds",
    label: "Failover duration",
    min: 5,
    max: 60,
    step: 5,
    value: 20,
    unit: "s",
    group: "Scenario",
    help: "How long the deployment has no writable primary. The driver waits for server selection before retrying; a long failover can exhaust that budget.",
    format: "number",
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
  failoverActive: boolean;
  retryableWrites: boolean;
  naiveRetry: boolean;
  failoverSeconds: number;
  duplicateEffects: number;
  errorRate: number;
  p99: number;
  writeCpu: number;
  retryBudgetExceeded: boolean;
  appHealth: Health;
  driverHealth: Health;
  oldPrimaryHealth: Health;
  newPrimaryHealth: Health;
}

function compute(p: Params, t: number): Computed {
  const writeRate = clamp(num(p, "writeRate", 8_000), 1_000, 30_000);
  const failover = num(p, "failover", 0) >= 0.5;
  const retryableWrites = num(p, "retryableWrites", 1) >= 0.5;
  const naiveRetry = num(p, "naiveRetry", 0) >= 0.5;
  const failoverSeconds = clamp(num(p, "failoverSeconds", 20), 5, 60);
  const elapsed = Math.max(0, t);
  const failoverActive = failover && elapsed < failoverSeconds;
  const retryBudgetExceeded = failover && failoverSeconds > SERVER_SELECTION_BUDGET;
  const duplicateEffects =
    failover && naiveRetry ? writeRate * 0.4 * Math.min(failoverSeconds, Math.max(1, elapsed)) : 0;
  const errorRate = failoverActive
    ? retryableWrites
      ? retryBudgetExceeded
        ? 100
        : 0
      : naiveRetry
        ? 0
        : 100
    : 0;
  const p99 = failoverActive
    ? retryableWrites
      ? retryBudgetExceeded
        ? 900
        : 180
      : naiveRetry
        ? 180
        : 900
    : 12;
  const writeCpu = clamp((writeRate / 30_000) * 100 + (retryableWrites && failoverActive ? 8 : 0), 0, 100);
  const appHealth: Health =
    duplicateEffects >= 100 || errorRate >= 10 ? "crit" : duplicateEffects > 0 || errorRate >= 1 ? "warn" : "ok";
  const driverHealth: Health = retryBudgetExceeded && failoverActive ? "crit" : failoverActive ? "warn" : "ok";
  const oldPrimaryHealth: Health = failoverActive
    ? "down"
    : writeCpu >= 90
      ? "crit"
      : writeCpu >= 70
        ? "warn"
        : "ok";
  const newPrimaryHealth: Health = failoverActive ? "warn" : writeCpu >= 90 ? "crit" : writeCpu >= 70 ? "warn" : "ok";
  return {
    writeRate,
    failoverActive,
    retryableWrites,
    naiveRetry,
    failoverSeconds,
    duplicateEffects,
    errorRate,
    p99,
    writeCpu,
    retryBudgetExceeded,
    appHealth,
    driverHealth,
    oldPrimaryHealth,
    newPrimaryHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application",
      kind: "client",
      health: values.appHealth,
      sublabel:
        values.duplicateEffects > 0
          ? `${Math.round(values.duplicateEffects).toLocaleString()} duplicate effects`
          : `${Math.round(values.writeRate).toLocaleString()} writes/s`,
      detail: "The application decides what a logical write is. If it retries with a new operation, the server cannot connect the retry to the original effect.",
      meta: { view: "flow" },
    },
    {
      id: "driver",
      label: "Driver session",
      kind: "service",
      health: values.driverHealth,
      utilization: values.failoverActive ? 0.8 : 0.2,
      throughput: values.writeRate,
      sublabel: values.failoverActive
        ? values.retryableWrites
          ? values.retryBudgetExceeded
            ? "retry budget exhausted"
            : "retry 1/1 · same txnNumber"
          : "no retryable write path"
        : "session + txnNumber",
      detail: "With retryable writes, the driver retries a supported write once with the same session and transaction number. The server uses that pair to recognize the retry.",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: values.failoverActive ? "Old primary" : "Primary",
      kind: "db",
      role: "primary",
      health: values.oldPrimaryHealth,
      sublabel: values.failoverActive ? "unreachable" : `p99 ${values.p99.toFixed(0)}ms`,
      detail: "The old primary accepted the original attempt or may have applied it before stepping down. A timeout does not tell the client which happened.",
      meta: { view: "flow" },
    },
    {
      id: "new-primary",
      label: values.failoverActive ? "New primary" : "Secondary",
      kind: "db",
      role: "replica",
      health: values.newPrimaryHealth,
      utilization: clamp(values.writeCpu / 100),
      throughput: values.writeRate,
      sublabel: values.failoverActive ? "elected · accepting retries" : `lag inside budget`,
      detail: "The new primary can deduplicate a retry if it has the same session and transaction number. Writes inside a transaction are not individually retryable, and an unacknowledged write concern is not retryable at all.",
      meta: { view: "flow" },
    },
    {
      id: "oplog",
      label: "Oplog",
      kind: "storage",
      health: values.failoverActive ? "warn" : "ok",
      sublabel: values.failoverActive ? "election in progress" : "replicating",
      detail: "The write and its session metadata travel through the oplog. The session identifies the operation; the transaction number distinguishes attempts.",
      meta: { view: "flow" },
    },
  ];
  const edges = [
    edge("app-driver", "app", "driver", values.writeRate / 30_000, values.appHealth),
    edge(
      "driver-primary",
      "driver",
      values.failoverActive ? "new-primary" : "primary",
      values.writeRate / 30_000,
      values.driverHealth,
    ),
    edge("primary-oplog", values.failoverActive ? "new-primary" : "primary", "oplog", values.writeRate / 30_000, values.newPrimaryHealth),
  ];
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("duplicate-effects", "Duplicate effects", values.duplicateEffects, "", 1, 100, "count"),
      metric("write-error-rate", "Write failure rate", values.errorRate, "%", 1, 10, "percent"),
      metric("failover-p99", "Write p99", values.p99, "ms", 50, 250, "ms"),
      metric("write-cpu", "Write CPU", values.writeCpu, "%", 70, 90, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, failover: values.failoverActive ? 1 : 0, retryableWrites: values.retryableWrites ? 1 : 0 },
    summary: `${values.failoverActive ? "Failover in progress" : "Primary available"} · retries ${values.retryableWrites ? "deduplicated" : "not deduplicated"} · ${Math.round(values.duplicateEffects).toLocaleString()} duplicate effects · errors ${values.errorRate.toFixed(0)}%`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 6)) / 2.4);
  for (const [id, value] of [
    ["duplicate-effects", values.duplicateEffects],
    ["write-error-rate", values.errorRate],
    ["failover-p99", values.p99],
    ["write-cpu", values.writeCpu],
  ] as const) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "duplicate-effects",
    metricId: "duplicate-effects",
    warn: 1,
    crit: 100,
    title: "A retry applied the same logical write twice",
    cause:
      "The application retried a write as a new operation after an ambiguous failure. Without the original session and transaction number, the server cannot tell the retry from a second, intentional write. The first attempt may have committed before the client saw the error.",
    fix:
      "Enable the driver's retryable-write path for supported operations, or make the write idempotent with a natural key or a deduplication record. Do not layer a second application retry on top of driver retries without an idempotency key.",
    checkFirst: [
      "Check whether duplicate business effects share the same logical key but different write attempts.",
      "Check whether the application created a new operation or reused the driver's retry.",
      "Check whether the operation is supported by retryable writes; multi-document updates are not.",
    ],
  },
  {
    id: "write-error-rate",
    metricId: "write-error-rate",
    warn: 1,
    crit: 10,
    title: "Writes fail during the failover window",
    cause:
      "There is no writable primary, the driver waited longer than its server-selection budget, or the retry was exhausted. A retryable write retries once; it does not wait forever for an election.",
    fix:
      "Wait for a primary and confirm a majority of voting members are healthy. If the failover is longer than the server-selection budget, raise the budget only with a matching application timeout, and add bounded backoff for operations outside the retryable set.",
    checkFirst: [
      "Check `rs.status()` for a primary and a voting majority.",
      "Check the driver's server-selection timeout and retry outcome.",
      "Check whether the failing operation is supported by retryable writes.",
    ],
  },
  {
    id: "failover-p99",
    metricId: "failover-p99",
    warn: 50,
    crit: 250,
    title: "Write latency includes the failover wait",
    cause:
      "The driver is waiting for a new primary before it can retry. The request is not doing database work for that whole interval; it is waiting on topology discovery and server selection.",
    fix:
      "Instrument the retry path separately from the server write path. Keep timeouts consistent across driver, load balancer, and application, and avoid retrying non-idempotent work blindly.",
    checkFirst: [
      "Check driver server-selection events and retry counts.",
      "Check whether p99 rose only during the election window.",
      "Check whether the application timeout fires before the driver finds a primary.",
    ],
  },
  {
    id: "write-cpu",
    metricId: "write-cpu",
    warn: 70,
    crit: 90,
    title: "The write path is saturated",
    cause:
      "The steady write rate is high, or retries add work during a failover. CPU saturation on the new primary can turn a short election into a longer recovery.",
    fix:
      "Reduce write amplification, add capacity, or shed noncritical writes. Retryable writes protect correctness; they do not add write capacity.",
    checkFirst: [
      "Check write rate and index maintenance on the new primary.",
      "Check whether retries are concentrated on a few large documents.",
      "Check disk I/O and queue depth as well as CPU.",
    ],
  },
];

export const retryableWritesModel: SimModel = {
  id: "mongodb-retryable-writes",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "failover-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.failoverActive && !Number(next.flags.failoverAnnounced ?? 0)) {
      pushEvent(next, {
        id: "primary-failed-retry",
        at: frame.t,
        severity: "crit",
        title: "Primary failed during an acknowledged write",
        detail: values.retryableWrites
          ? "The driver is waiting for a new primary. A supported write can be retried once with the same session and transaction number."
          : "The driver has no retryable-write path. A write that timed out may have committed or failed; the client cannot tell which.",
        nodeId: "primary",
      });
      next.flags.failoverAnnounced = 1;
    }
    if (values.duplicateEffects >= 100 && !Number(next.flags.duplicateAnnounced ?? 0)) {
      pushEvent(next, {
        id: "duplicate-write-observed",
        at: frame.t,
        severity: "crit",
        title: "Duplicate effects detected",
        detail: `${Math.round(values.duplicateEffects).toLocaleString()} duplicate effects have accumulated. These came from the application retrying without retryable-write semantics, not from the driver's single retry.`,
        nodeId: "app",
        metricId: "duplicate-effects",
      });
      next.flags.duplicateAnnounced = 1;
    }
    if (!values.failoverActive && Number(frame.flags.failover ?? 0) === 1 && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "write-path-recovered",
        at: frame.t,
        severity: values.duplicateEffects > 0 ? "warn" : "info",
        title: "A writable primary is available again",
        detail:
          values.duplicateEffects > 0
            ? "Latency and errors recovered, but duplicate effects remain in the data. Correctness is a separate recovery task."
            : "The retry path completed without duplicate effects. Confirm that the application did not retry the same logical write outside the driver.",
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (!values.failoverActive) next.flags.failoverAnnounced = 0;
    if (values.duplicateEffects === 0) next.flags.duplicateAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0);
    return [
      `During the failover, the driver ${values.retryableWrites ? "can retry a supported write once with the same session and transaction number" : "has no retryable-write path"}. The application path is ${values.naiveRetry ? "retrying as a new write" : "not retrying"}.`,
      values.duplicateEffects > 0
        ? "The duplicate counter is a correctness signal, not a latency signal. It stays high after the primary recovers because the effects are already in the data."
        : "No duplicate effects are modeled. That does not prove the operation is exactly-once: an expired session or a write outside the retryable set can still change the outcome.",
      `The write path is at ${values.writeCpu.toFixed(0)}% of its illustrative CPU capacity. Retryable writes protect correctness; they do not make the new primary faster.`,
      "Illustrative model. Failover timing, retry cost, and duplicate share are teaching values. MongoDB documents one driver retry, session plus transaction-number deduplication, and a server-selection wait.",
    ];
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
    description: "Retryable writes are enabled but no failover is occurring.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High write volume with no failure; the primary is saturated but retries are not involved.",
    tone: "warn",
    params: defaults({ writeRate: 25_000 }),
  },
  {
    id: "failure",
    label: "Naive retry",
    description: "The primary fails and the application retries as a new write, creating duplicate effects.",
    tone: "crit",
    params: defaults({ writeRate: 10_000, failover: 1, retryableWrites: 0, naiveRetry: 1, failoverSeconds: 20 }),
  },
  {
    id: "retryable",
    label: "Retryable writes",
    description: "The driver retries once with the same session and transaction number; no duplicate effects.",
    tone: "warn",
    params: defaults({ writeRate: 10_000, failover: 1, retryableWrites: 1, naiveRetry: 0, failoverSeconds: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A primary is available and no application retry is layered on top.",
    tone: "ok",
    params: defaults({ writeRate: 8_000, failover: 0, retryableWrites: 1, naiveRetry: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-retry-dedupe",
  title: "Predict whether the retry can duplicate the write",
  simId: "retryable-writes",
  question:
    "Retryable writes are enabled. A write times out during failover, and the driver retries it once with the same session and transaction number. Can the document be inserted twice?",
  prediction: {
    options: [
      { id: "twice", label: "Yes: every retry inserts a second document because the server cannot see the first attempt" },
      { id: "dedupe", label: "No: the server recognizes the session and transaction number and does not apply the retry again" },
      { id: "always", label: "No: retryable writes make every MongoDB operation exactly-once" },
      { id: "read", label: "Only if the write is a read, because reads are never retryable" },
    ],
    correctOptionId: "dedupe",
    explanation:
      "The driver retries once with the same session and transaction number. The server uses that pair to recognize the retry and avoid applying the same write twice. The guarantee depends on the retry staying inside that session's window and on the operation being in the supported set. If the application creates a new write or session, the server sees a new operation.",
  },
  setup: defaults({ writeRate: 10_000, failover: 1, retryableWrites: 1, naiveRetry: 0, failoverSeconds: 20 }),
  runFor: 10,
  observe: [
    "The old primary is unavailable during the failover.",
    "The driver waits for server selection and retries once.",
    "Duplicate effects stay at zero because the retry uses the same session and transaction number.",
    "Write latency is elevated for the failover window and recovers afterward.",
  ],
  explain:
    "A retryable write is not a new write. It carries the same session identifier and transaction number, and the server records enough state to recognize a duplicate attempt. That is why the driver retries once rather than looping. The mechanism does not cover every operation: writes inside transactions are not individually retryable, multi-document updates are not in the retryable set, and an unacknowledged write concern is not retryable. A client that is unresponsive beyond the session timeout can also retry into an ambiguous state.",
  fix: defaults({ writeRate: 8_000, failover: 0, retryableWrites: 1, naiveRetry: 0 }),
  debrief:
    "Keep the driver retry path and remove the application's blind retry. Make the operation idempotent where the business effect matters, especially for multi-document updates and writes with weak acknowledgment. Alert on duplicate business keys, not only on driver errors. The tradeoff is that retryable writes add session metadata and a waiting period during failover; they do not add capacity or make a weak write concern durable.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A retryable write is a write the driver may retry once after a network error or when it cannot find a healthy primary. The driver attaches a session identifier and a transaction number. The server records the attempt so that if the same session and transaction number arrive again, it can recognize the retry instead of applying the write twice.",
  },
  {
    type: "p",
    text: "The hard part is the ambiguous result. A timeout means the client did not receive an acknowledgment; it does not mean the server did not commit the write. Without retryable semantics, a blind retry can insert the same logical record twice. With retryable semantics, the driver can retry the same operation and let the server decide whether it already ran.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Retryable writes sit in the driver and the server session layer. The driver detects a retryable error, waits for server selection, and retries once. The server uses the session and transaction number to deduplicate. The mechanism requires a replica set or sharded cluster, a storage engine with document-level locking, and an acknowledged write concern.",
  },
  {
    type: "table",
    headers: ["Layer", "What it does", "What it cannot do"],
    rows: [
      ["Application retry", "Retries the business operation", "Know whether the first attempt committed"],
      ["Driver retryable write", "Retries once with session + transaction number", "Retry forever or cover every operation"],
      ["Server deduplication", "Recognizes the same attempt", "Repair a write that was never acknowledged"],
      ["Idempotent write", "Makes the effect safe to repeat", "Replace durability or write concern"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Duplicate effects: the correctness signal that a retry created a second logical write.",
      "Write failure rate: attempts that could not find a primary or exhausted the retry.",
      "Write p99: the failover wait, which is mostly server selection rather than database work.",
      "Write CPU: the steady load on the new primary, including retry work.",
      "Retry state: whether the driver is using the same session and transaction number.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Retryable writes to see a single retry with no duplicate effects. Apply Naive retry to see duplicates accumulate while latency recovers. Compare the recovery preset. Use the experiment before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Retryable is not exactly-once",
    body: "The driver retries once, and the server deduplicates that attempt. An application that builds a new write, a session that expires, or a write outside the supported set is a different operation. Writes with `w:0` are not retryable, and writes inside a transaction are not individually retryable.",
  },
  { type: "sim", simId: "retryable-writes" },
  { type: "experiment", experimentId: "predict-retry-dedupe" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary disappeared after the client sent a write. The client saw a timeout, which did not tell it whether the write had committed. With the driver's retryable-write path, the same session and transaction number were retried once after a new primary appeared, and the server recognized the attempt. With a naive application retry, the second attempt was a new write, so the effect could be applied twice. Latency recovered when the failover ended; the duplicate effects did not disappear.",
  },
  {
    type: "p",
    text: "The retry solved a correctness problem at the protocol layer, not a capacity problem. The new primary still had to absorb the writes, and the driver still had to wait for server selection. The application's own retry policy remained a separate decision, and layering it on top of driver retries reintroduced the duplicate risk.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The driver reports a retryable error or a server-selection timeout during the election.",
      "Duplicate business keys or repeated side effects appear even though the driver reports success.",
      "`serverStatus` exposes retryable-write statistics in its transactions section.",
      "Write p99 covers the election wait; the server may have done no work for part of that interval.",
      "Operations outside the retryable set still fail or duplicate when the application retries them.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the duplicate effect came from the driver's single retry or from an application retry with a new operation. Check the operation type and write concern: `w:0` and multi-document updates are not protected the way a single-document acknowledged write is. Check whether the failover exceeded the driver's server-selection budget.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Keep the driver's retryable-write path for supported, acknowledged operations.",
      "Remove blind application retries, or give them an idempotency key.",
      "Make the business effect idempotent for operations outside the retryable set.",
      "Align driver, load-balancer, and application timeouts with the failover budget.",
      "Alert on duplicate business keys, not only on driver error rates.",
      "Reconcile duplicate effects after recovery; latency recovery is not correctness recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Retryable writes add session metadata and one retry of latency during failover.",
      "Idempotency keys add storage and application complexity but cover operations the driver cannot.",
      "A longer server-selection budget tolerates slower elections but holds requests open longer.",
      "A shorter timeout fails fast but increases duplicate risk if the application retries blindly.",
      "Exactly-once effects require an idempotent write or a transactional boundary, not retryable writes alone.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "how-dedupe",
    question: "How does MongoDB avoid applying a retried write twice?",
    difficulty: 3,
    hints: [
      "The driver carries more than the document.",
      "The server needs a stable identifier for the attempt.",
      "The retry is bounded.",
    ],
    answer:
      "The driver attaches a session identifier and a transaction number to the write. On a retryable error it retries once with the same pair. The server records the attempt and uses that pair to recognize the retry, so it does not apply the same write again. The guarantee is bounded: it applies to supported operations, requires an acknowledged write concern, and depends on the session remaining valid.",
    followUps: [
      "Which operations are not covered?",
      "What happens if the client is unresponsive past the session timeout?",
      "How does write concern interact with this?",
    ],
    redFlags: [
      "Says the driver retries forever.",
      "Claims all writes are covered.",
      "Ignores sessions and transaction numbers.",
    ],
    rubric: [
      "Names session and transaction number.",
      "States one retry.",
      "Names the supported-operation and write-concern limits.",
      "Mentions session expiry.",
    ],
  },
  {
    id: "ambiguous",
    question: "A write times out during failover. What do you know, and what do you not know?",
    difficulty: 2,
    hints: [
      "A timeout is not a failure result.",
      "The server may have committed before stepping down.",
      "Retryable writes reduce one kind of ambiguity.",
    ],
    answer:
      "I know the client did not receive an acknowledgment within its timeout. I do not know whether the server applied the write, whether it was replicated, or whether the new primary has it. A retryable write can resolve the ambiguity for a supported operation by retrying with the same session and transaction number. If the operation is not covered, I need an idempotency key or a read-back to determine the state before retrying.",
    followUps: [
      "How would you read back safely?",
      "What changes with `w:majority`?",
      "When is a duplicate acceptable?",
    ],
    redFlags: [
      "Treats a timeout as a definite failure.",
      "Retries immediately without checking the operation type.",
      "Assumes the new primary has every acknowledged write.",
    ],
    rubric: [
      "Separates timeout from outcome.",
      "Names commit and replication uncertainty.",
      "Uses retryable semantics or idempotency.",
      "Mentions read-back.",
    ],
  },
  {
    id: "not-retryable",
    question: "Which writes are not protected by retryable writes, and what do you do instead?",
    difficulty: 3,
    hints: [
      "Think about multi-document updates.",
      "Think about unacknowledged writes.",
      "Think about operations inside a transaction.",
    ],
    answer:
      "Writes with `w:0` are not retryable, multi-document updates such as `updateMany` are outside the retryable set, and writes inside a transaction are not individually retryable. I would use an idempotency key or a natural unique constraint for those effects, or restructure the operation so the retry is safe. For transactions, I would retry the commit or abort through the driver's transaction retry path rather than each statement.",
    followUps: [
      "How would an idempotency key work for `updateMany`?",
      "What does the driver retry for a transaction?",
      "Why does `w:0` break the mechanism?",
    ],
    redFlags: [
      "Assumes every write is retryable.",
      "Retries each statement inside a transaction.",
      "Uses `w:0` and expects durability.",
    ],
    rubric: [
      "Names `w:0`, multi-document updates, and in-transaction writes.",
      "Offers idempotency or restructuring.",
      "Distinguishes transaction commit retries.",
      "Connects write concern to durability.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Retryable writes are enabled where the driver and deployment support them.",
      "Operations outside the retryable set have an idempotency strategy.",
      "Driver, load-balancer, and application timeouts are aligned.",
      "Dashboards show duplicate business keys, not only driver errors.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the duplicate came from the driver or an application retry.",
      "Check the operation type and write concern.",
      "Check whether the failover exceeded the server-selection budget.",
      "Do not retry non-idempotent work blindly.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile duplicate effects before declaring recovery.",
      "Confirm the driver retry path completed.",
      "Review timeout alignment against the observed failover.",
      "Add idempotency where the supported set does not cover the operation.",
    ],
  },
];

const references = [
  {
    title: "Retryable Writes",
    url: "https://www.mongodb.com/docs/manual/core/retryable-writes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "One driver retry, supported operations, write-concern requirements, and failover behavior.",
  },
  {
    title: "Session",
    url: "https://www.mongodb.com/docs/manual/reference/method/Session/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Session identifiers, transaction numbers, and the client session lifecycle.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "retryable-writes": {
      model: retryableWritesModel,
      presets,
      instructions:
        "Start Healthy, then apply Naive retry to see duplicate effects accumulate while latency recovers. Apply Retryable writes to compare the same failover with a single deduplicated retry.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Failover timing, retry cost, and duplicate share are teaching values. MongoDB documents one driver retry and session plus transaction-number deduplication.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-idempotency", "mongodb-replica-set", "mongodb-write-concern"],
};
