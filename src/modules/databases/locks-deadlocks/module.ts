import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "writeRate",
    label: "Write transaction rate",
    min: 10,
    max: 1_000,
    step: 10,
    value: 100,
    unit: " tx/s",
    group: "Workload",
    help: "Concurrent write transactions per second. More overlap means more chances to wait on the same rows.",
    format: "rps" as const,
  },
  {
    id: "lockHoldMs",
    label: "Lock hold time",
    min: 10,
    max: 2_000,
    step: 10,
    value: 200,
    unit: " ms",
    group: "Workload",
    help: "How long a transaction holds its first row lock before requesting the next. Longer holds widen the window for another transaction to interleave.",
    format: "ms" as const,
  },
  {
    id: "consistentOrder",
    label: "Consistent lock order",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Application",
    help: "1 means every transaction locks the same rows in the same order. 0 models opposite order, which can form a cycle.",
    format: "count" as const,
  },
  {
    id: "retryBackoff",
    label: "Jittered retry backoff",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Application",
    help: "1 retries with exponential backoff and jitter. 0 retries immediately, so aborted transactions collide again.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function status(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Computed {
  writeRate: number;
  holdMs: number;
  consistent: boolean;
  backoff: boolean;
  contention: number;
  waitP95: number;
  deadlocksPerMinute: number;
  retryMultiplier: number;
  blockedSessions: number;
  appHealth: Health;
  waiterHealth: Health;
  lockHealth: Health;
  queueHealth: Health;
}

function compute(p: Params): Computed {
  const writeRate = clamp(num(p, "writeRate", 100), 10, 1_000);
  const holdMs = clamp(num(p, "lockHoldMs", 200), 10, 2_000);
  const consistent = num(p, "consistentOrder", 1) >= 0.5;
  const backoff = num(p, "retryBackoff", 1) >= 0.5;
  const contention = (writeRate * (holdMs / 1_000)) / 50;
  const effectiveContention = contention * (consistent ? 0.4 : 1);
  const waitP95 = holdMs * (1 + effectiveContention);
  const deadlocksPerMinute = consistent ? 0 : Math.max(0, contention - 1) * 2;
  const retryMultiplier = backoff ? 1 : 1 + deadlocksPerMinute * 0.3;
  const blockedSessions = Math.min(writeRate, contention * 5);
  return {
    writeRate,
    holdMs,
    consistent,
    backoff,
    contention,
    waitP95,
    deadlocksPerMinute,
    retryMultiplier,
    blockedSessions,
    appHealth: status(retryMultiplier, 2, 4),
    waiterHealth: status(waitP95, 300, 1_500),
    lockHealth: status(deadlocksPerMinute, 1, 5),
    queueHealth: status(blockedSessions, 6, 20),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["wait-p95", values.waitP95, 2],
    ["deadlocks", values.deadlocksPerMinute, 0.05],
    ["retry-multiplier", values.retryMultiplier, 0.02],
    ["blocked-sessions", values.blockedSessions, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const lockConflict: Health = values.consistent ? "ok" : values.lockHealth;
  return {
    t: 0,
    nodes: [
      {
        id: "pool",
        label: "Application pool",
        kind: "service",
        health: values.appHealth,
        utilization: clamp(values.retryMultiplier / 6),
        sublabel: `${values.retryMultiplier.toFixed(1)}x retry amplification`,
        detail:
          "Immediate retries re-enter the same contention. With backoff and jitter, retries spread out and the lock queue can drain.",
        meta: { retries: Number(values.retryMultiplier.toFixed(2)) },
      },
      {
        id: "session-a",
        label: "Session A",
        kind: "worker",
        health: values.waiterHealth,
        utilization: clamp(values.waitP95 / 6_000),
        sublabel: `waits ${values.waitP95.toFixed(0)} ms p95`,
        detail:
          "A session waiting for a row lock is not necessarily blocked forever. The question is who holds the lock and whether that holder will ever release it.",
        meta: { wait: Math.round(values.waitP95) },
      },
      {
        id: "row-lock",
        label: "Row locks",
        kind: "db",
        role: "primary",
        health: lockConflict,
        utilization: clamp(values.deadlocksPerMinute / 12),
        sublabel: values.consistent
          ? "ordered acquisition"
          : `${values.deadlocksPerMinute.toFixed(1)} deadlocks/min`,
        detail: values.consistent
          ? "Every transaction takes the same rows in the same order, so a cycle cannot form. Waits still exist; deadlocks do not."
          : "Transactions take the same rows in opposite order. A waits for B's row while B waits for A's row, and neither can release what the other needs.",
        meta: { deadlocks: Number(values.deadlocksPerMinute.toFixed(2)) },
      },
      {
        id: "session-b",
        label: "Session B",
        kind: "worker",
        health: values.queueHealth,
        utilization: clamp(values.blockedSessions / 60),
        sublabel: `${formatCount(values.blockedSessions)} sessions queued`,
        detail:
          "Waiters queue behind the current holder. The queue consumes connections and worker capacity even when the database is not CPU-bound; `deadlock_timeout` decides when a cycle is detected, not how long a normal wait lasts.",
        meta: { blocked: Math.round(values.blockedSessions) },
      },
    ],
    edges: [
      edge("a-locks", "session-a", "row-lock", clamp(values.waitP95 / 6_000), values.waiterHealth, "row lock request"),
      edge("b-locks", "session-b", "row-lock", clamp(values.blockedSessions / 60), values.queueHealth, "row lock request"),
      edge("retry", "pool", "session-a", clamp(values.retryMultiplier / 6), values.appHealth, "retry"),
    ],
    metrics: [
      metric("wait-p95", "Lock wait p95", values.waitP95, " ms", 300, 1_500, "ms"),
      metric("deadlocks", "Deadlocks per minute", values.deadlocksPerMinute, "/min", 1, 5, "number"),
      metric("retry-multiplier", "Retry amplification", values.retryMultiplier, "x", 2, 4, "number"),
      metric("blocked-sessions", "Blocked sessions", values.blockedSessions, "", 6, 20, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.consistent
      ? `Ordered locking: wait p95 ${values.waitP95.toFixed(
          0,
        )} ms, no deadlocks, ${formatCount(values.blockedSessions)} sessions queued.`
      : `Opposite lock order: wait p95 ${values.waitP95.toFixed(0)} ms, ${values.deadlocksPerMinute.toFixed(
          1,
        )} deadlocks/min, retry amplification ${values.retryMultiplier.toFixed(1)}x.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lock-wait",
    metricId: "wait-p95",
    warn: 300,
    crit: 1_500,
    title: "Lock waits are dominating latency",
    cause:
      "Transactions hold row locks while they do other work, and concurrent transactions request the same rows. The queue grows with hold time and overlap, not with database CPU.",
    fix:
      "Shorten transactions, move network calls and user think time outside the transaction, add the right index so fewer rows are locked, and set `lock_timeout` so a request fails instead of waiting indefinitely.",
    checkFirst: [
      "Find the blocking session with `pg_blocking_pids(pid)` and read its current statement.",
      "Check `pg_stat_activity` for sessions idle in transaction, which hold locks without doing work.",
      "Check whether the query locks more rows than it needs because of a missing index.",
    ],
  },
  {
    id: "deadlock",
    metricId: "deadlocks",
    warn: 1,
    crit: 5,
    title: "Deadlocks are aborting transactions",
    cause:
      "Two or more transactions acquired locks in different orders and each needs a row the other holds. PostgreSQL detects the cycle after `deadlock_timeout` and aborts one transaction.",
    fix:
      "Make lock acquisition order deterministic across code paths, shorten transactions, and retry the aborted transaction with backoff and jitter. A deadlock is a correct abort, not a database bug.",
    checkFirst: [
      "Read the deadlock detail in the PostgreSQL log; it names both statements and the rows.",
      "Map the two code paths to their lock order and find the inconsistent one.",
      "Check whether ORM hooks or background jobs update the same rows in a different order.",
    ],
  },
  {
    id: "retry",
    metricId: "retry-multiplier",
    warn: 2,
    crit: 4,
    title: "Retries are amplifying the contention",
    cause:
      "Immediate retries put aborted transactions back into the same lock queue, so each deadlock creates more attempts and more contention. The retry policy becomes part of the load.",
    fix:
      "Retry with exponential backoff and jitter, cap attempts, and make the transaction idempotent. Route non-idempotent operations to a deduplicated queue rather than retrying blindly.",
    checkFirst: [
      "Measure attempts per logical request, not just failed requests.",
      "Check whether the retry loop reuses the same transaction or starts a new one.",
      "Check for retry storms across application instances after a deadlock.",
    ],
  },
  {
    id: "blocked",
    metricId: "blocked-sessions",
    warn: 6,
    crit: 20,
    title: "Too many sessions are queued on locks",
    cause:
      "A single long holder can block many waiters. The queue consumes connections and worker capacity even though the database is not CPU-bound.",
    fix:
      "Release the blocker, bound the queue with `lock_timeout` and pool limits, and move long maintenance or reporting work off the write path.",
    checkFirst: [
      "Group waiters by blocker; one blocker often explains most of the queue.",
      "Check connection-pool saturation and queue wait time.",
      "Check whether a batch job or migration is holding the lock.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const locksModel: SimModel = {
  id: "databases-locks-deadlocks",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, values, seed);
    pushEvent(frame, {
      id: "lock-monitor-ready",
      at: 0,
      severity: "info",
      title: "Lock monitor attached",
      detail: "Apply a preset or change the transaction order to watch waits and deadlocks form.",
      nodeId: "row-lock",
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
    if (!values.consistent && frame.flags.deadlockLogged !== 1) {
      pushEvent(next, {
        id: "deadlock-detected",
        severity: "crit",
        title: "Deadlock cycle detected",
        detail: `Transactions acquired rows in opposite order. PostgreSQL aborted one after the deadlock check; the app must retry with jitter, not immediately.`,
        nodeId: "row-lock",
        metricId: "deadlocks",
      });
    }
    if (!values.backoff && values.deadlocksPerMinute >= 1 && frame.flags.retryLogged !== 1) {
      pushEvent(next, {
        id: "retry-storm",
        severity: "warn",
        title: "Immediate retries amplify the queue",
        detail: `Retry amplification is ${values.retryMultiplier.toFixed(
          1,
        )}x. Each abort returns to the same lock order and collides again.`,
        nodeId: "pool",
        metricId: "retry-multiplier",
      });
    }
    next.flags = {
      ...frame.flags,
      ...next.flags,
      deadlockLogged: values.consistent ? 0 : 1,
      retryLogged: !values.backoff && values.deadlocksPerMinute >= 1 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `Lock wait p95 is ${values.waitP95.toFixed(
        0,
      )} ms. It grows with hold time and with the number of overlapping transactions.`,
      values.consistent
        ? "Consistent lock ordering removes cycles, but it does not remove waiting. The queue can still be long if transactions hold locks for too long."
        : `Opposite lock order creates ${values.deadlocksPerMinute.toFixed(
            1,
          )} deadlocks per minute. PostgreSQL aborts one transaction per cycle; the application still has to retry.`,
      `Retry amplification is ${values.retryMultiplier.toFixed(
        1,
      )}x. Immediate retries turn an abort into more load on the same rows.`,
      `About ${formatCount(values.blockedSessions)} sessions are queued. Investigate the holder before terminating waiters.`,
    ];
    items.push(
      "A deadlock is not the same as a lock wait: a wait may resolve when the holder commits, while a cycle cannot resolve without an abort.",
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
    description: "Low overlap, short transactions, consistent lock order, and jittered retries.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy but ordered",
    description: "Higher write rate and 300 ms lock holds. Waits rise, but consistent ordering prevents deadlocks.",
    tone: "warn",
    params: defaults({ writeRate: 200, lockHoldMs: 300 }),
  },
  {
    id: "failure",
    label: "Deadlock storm",
    description: "Opposite lock order, 800 ms holds, and immediate retries turn aborts into a contention loop.",
    tone: "crit",
    params: defaults({ writeRate: 400, lockHoldMs: 800, consistentOrder: 0, retryBackoff: 0 }),
  },
  {
    id: "retry-storm",
    label: "Immediate retries",
    description: "A moderate deadlock rate is amplified because every aborted transaction retries at once.",
    tone: "warn",
    params: defaults({ writeRate: 250, lockHoldMs: 400, consistentOrder: 0, retryBackoff: 0 }),
  },
  {
    id: "recovery",
    label: "Ordered and retried",
    description: "Consistent lock order plus jittered retries keep waits and deadlocks below the warning lines.",
    tone: "ok",
    params: defaults({ writeRate: 150, lockHoldMs: 100, consistentOrder: 1, retryBackoff: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-deadlock-resolution",
  title: "Predict what PostgreSQL does with the cycle",
  simId: "locks-deadlocks",
  question:
    "Two sessions update rows in opposite order and each holds its first row for 2 seconds. Both request the other's row at the same time. What happens next?",
  prediction: {
    options: [
      { id: "wait", label: "Both wait forever until an operator kills one." },
      { id: "detect", label: "PostgreSQL detects the cycle after deadlock_timeout and aborts one transaction." },
      { id: "both", label: "Both transactions proceed after a timeout without an abort." },
      { id: "first", label: "The first transaction commits and the second proceeds automatically." },
    ],
    correctOptionId: "detect",
    explanation:
      "A cycle is not a normal wait. PostgreSQL checks for deadlocks after a lock wait exceeds `deadlock_timeout` (1 second by default), finds the cycle, and aborts one of the transactions so the other can proceed. The aborted transaction receives an error and must be retried by the application. Which transaction is aborted is not predictable.",
  },
  setup: defaults({ writeRate: 100, lockHoldMs: 2_000, consistentOrder: 0, retryBackoff: 0 }),
  runFor: 20,
  observe: [
    "Lock wait p95 reaches 10 seconds and crosses the critical threshold.",
    "Deadlocks reach about 6 per minute and cross the critical threshold.",
    "Blocked sessions cross the critical threshold as the queue builds.",
    "Retry amplification is 2.8x because immediate retries re-enter the same order.",
    "The row-lock node fails; the application pool is the amplifier, not the cause.",
  ],
  explain:
    "The database did its job: it detected an unresolvable cycle and aborted one transaction. The failure is in the application's transaction ordering and retry policy. Immediate retries put the aborted transaction back into the same lock queue, so the database spends capacity aborting work that will collide again.",
  fix: defaults({ writeRate: 100, lockHoldMs: 200, consistentOrder: 1, retryBackoff: 1 }),
  debrief:
    "With a consistent order and short holds, the same workload drops to a 232 ms wait p95 and zero deadlocks. The fix was not a bigger database or a longer timeout; it was removing the cycle and backing off when an abort still happens.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A row lock protects a row while a transaction changes it. Other transactions that need the same row wait, or time out. A lock wait is normal and often short. A deadlock is a cycle: transaction A holds row 1 and waits for row 2, while transaction B holds row 2 and waits for row 1. Neither can proceed, so PostgreSQL detects the cycle and aborts one transaction.",
  },
  {
    type: "p",
    text: "PostgreSQL checks for deadlocks after a lock wait exceeds `deadlock_timeout`, which defaults to one second. It logs the deadlock, aborts one transaction in the cycle, and lets the others continue. The application receives an error and must retry the whole transaction. Which transaction is chosen is not something to depend on.",
  },
  {
    type: "p",
    text: "Most deadlocks are application bugs, not database bugs. Two code paths update the same rows in different orders, or an ORM writes parent and child rows in an order that varies with the request. Consistent lock ordering removes most cycles. Shorter transactions reduce the window. A correct retry policy with backoff and jitter prevents an abort from turning into a storm.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application opens a transaction, takes row locks as it writes, and holds them until commit or rollback. `pg_locks` shows the locks; `pg_stat_activity` shows the sessions and their wait events; `pg_blocking_pids(pid)` returns the sessions blocking a given backend. A waiter is the symptom. The blocker is the cause, unless the blocker is itself waiting in a cycle.",
  },
  {
    type: "table",
    headers: ["Signal", "What it means", "First action"],
    rows: [
      ["Lock wait", "One session holds what another needs", "Find the blocker and its statement"],
      ["Deadlock", "A cycle was detected and one transaction aborted", "Read the log, fix the lock order"],
      ["Idle in transaction", "Locks held with no active work", "End the session or set a timeout"],
      ["Long wait queue", "Many sessions blocked by one holder", "Release the holder; bound the queue"],
    ],
  },
  {
    type: "p",
    text: "Timeouts change the failure mode. `lock_timeout` makes a statement fail instead of waiting past a bound. `statement_timeout` bounds the whole statement. `idle_in_transaction_session_timeout` ends a session that holds locks without doing work. Each one converts a wait into an error, so the application must handle the error rather than assume the transaction will finish.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Lock wait p95: the time a transaction spends waiting for a row lock.",
      "Deadlocks per minute: cycles detected and aborted, not waits that resolved.",
      "Retry amplification: attempts per logical transaction when retries are immediate.",
      "Blocked sessions: the queue behind the current holders.",
      "Row-lock state: ordered acquisition or an unresolvable cycle.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Deadlock storm and read the wait and deadlock lines before changing anything. Switch consistent order on and watch deadlocks disappear while waits remain. Then turn off retry backoff to see amplification rise without any change in the database. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Wait times, deadlock counts, retry multipliers, and thresholds are illustrative teaching values. PostgreSQL's actual behavior depends on the statements, indexes, isolation level, and lock modes involved.",
  },
  { type: "sim", simId: "locks-deadlocks" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, opposite lock order produced about 11 deadlocks per minute with 800 ms holds. Wait p95 reached 5.9 seconds and 32 sessions were queued. Immediate retries raised amplification to 4.2x, so each abort created more attempts on the same rows. The database was doing exactly what it should: aborting one transaction per cycle.",
  },
  {
    type: "p",
    text: "Turning on consistent lock order removed the cycles, but waits remained because transactions still held locks. Shortening the hold time reduced the queue. The two fixes address different failures: ordering prevents deadlocks, and short transactions reduce contention.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`ERROR: deadlock detected` in the PostgreSQL log, with the two statements and the lock detail.",
      "`pg_stat_database.deadlocks` rising for the database, and per-table or per-query patterns in the logs.",
      "Wait events of type Lock, with `pg_blocking_pids(pid)` naming the blocker.",
      "Sessions idle in transaction, or long-running batch jobs holding row locks.",
      "Application retry counts, duplicate side effects, and pool saturation while the database is not CPU-bound.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the deadlock log entry and identify the two lock orders. Then check for a long blocker and sessions idle in transaction. Do not terminate the first waiting session you see; find the holder, and confirm whether the wait is a cycle or a queue.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the deadlock log entry and map each statement to its lock order.",
      "Change the inconsistent code path so every transaction acquires rows in the same order.",
      "Shorten transactions: no network calls, user input, or slow computation while locks are held.",
      "Add the index that lets the statement lock fewer rows, and check the isolation level.",
      "Set `lock_timeout` and `idle_in_transaction_session_timeout` so waits cannot grow without bound.",
      "Retry aborted transactions with exponential backoff and jitter; cap attempts and keep the operation idempotent.",
      "For a long blocker, decide between canceling the statement and terminating the session, and state the rollback cost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Consistent lock ordering prevents cycles but can serialize work that previously ran in parallel.",
      "A short `lock_timeout` protects the pool but turns long waits into user-visible errors.",
      "Terminating a session releases locks immediately but rolls back its transaction and may leave external side effects.",
      "Higher isolation levels reduce anomalies but increase locking and deadlock risk.",
      "Retries with backoff reduce load but add latency; retries without idempotency can duplicate writes.",
      "Killing the blocker is fast, but the same pattern returns unless the code path is fixed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-blocker",
    question: "Writes are hanging and the database reports deadlocks. Which query do you inspect first?",
    difficulty: 3,
    hints: [
      "Start with the waiters and their blockers, not with CPU.",
      "A deadlock log entry names the statements in the cycle.",
    ],
    answer:
      "I would look at `pg_stat_activity` for sessions with a Lock wait event and use `pg_blocking_pids(pid)` to identify the blockers. Then I would read the current or most recent statement for each blocker and check for sessions idle in transaction. In parallel I would read the deadlock log entry, because it shows the two statements and the rows in the cycle. That tells me whether this is a queue behind one holder or a genuine cycle that needs a code fix.",
    followUps: [
      "What if the blocker is also waiting?",
      "How do you tell a deadlock from a long lock wait?",
      "When would you terminate a session?",
    ],
    redFlags: [
      "Starts by killing waiting sessions.",
      "Looks only at CPU or disk.",
      "Treats every lock wait as a deadlock.",
    ],
    rubric: [
      "Uses `pg_blocking_pids` or an equivalent wait graph.",
      "Reads the blocker's statement.",
      "Checks idle-in-transaction sessions.",
      "Reads the deadlock log.",
    ],
  },
  {
    id: "prevent-deadlocks",
    question: "How do you prevent deadlocks without eliminating concurrency?",
    difficulty: 3,
    hints: [
      "Ordering removes cycles; it does not remove waits.",
      "Short transactions shrink the window.",
    ],
    answer:
      "I would make lock acquisition order deterministic across all code paths that touch the same rows, so a cycle cannot form. I would shorten transactions so locks are held for less time, add indexes so statements lock fewer rows, and check the isolation level for unnecessary locking. I would still expect waits, so I would set `lock_timeout` and implement a bounded retry with backoff and jitter. Ordering prevents deadlocks; short transactions and indexes reduce contention.",
    followUps: [
      "Why does consistent ordering not eliminate waiting?",
      "How would you retrofit ordering into an existing ORM?",
      "What does a higher isolation level change?",
    ],
    redFlags: [
      "Suggests a global lock for everything.",
      "Raises `deadlock_timeout` and calls it fixed.",
      "Ignores transaction length.",
    ],
    rubric: [
      "Orders lock acquisition.",
      "Shortens transactions.",
      "Reduces rows locked with indexes.",
      "Keeps a bounded retry policy.",
    ],
  },
  {
    id: "kill-or-wait",
    question: "A session has held a row lock for 20 minutes and 40 sessions are queued. Do you terminate it?",
    difficulty: 3,
    hints: [
      "Identify what the session has done and what rollback costs.",
      "Consider canceling the statement versus terminating the session.",
    ],
    answer:
      "I would first identify the session and its statement, and check whether it is idle in transaction or actively doing work. If it is a runaway report or a stuck batch job, I would cancel the statement first, which stops the query and forces the transaction to roll back. If it is idle in transaction and holding locks without progress, I would terminate the session. Before either, I would check what external side effects the transaction has and whether the work can be restarted safely. Terminating releases the queue but rolls back the transaction, so it is not free.",
    followUps: [
      "What is the difference between cancel and terminate?",
      "How do you prevent the same session from blocking again?",
      "What do you tell the owner of the blocked work?",
    ],
    redFlags: [
      "Terminates without identifying the statement.",
      "Assumes rollback is harmless.",
      "Ignores the queued sessions and pool exhaustion.",
    ],
    rubric: [
      "Identifies the session and statement.",
      "Distinguishes cancel from terminate.",
      "Considers rollback and side effects.",
      "Prevents recurrence with timeouts.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every code path that updates the same rows acquires locks in a consistent order.",
      "Transactions do not perform network calls or wait for user input while holding locks.",
      "`lock_timeout`, `statement_timeout`, and `idle_in_transaction_session_timeout` are set per role.",
      "Deadlock counts and lock wait events are monitored, not just CPU and query duration.",
      "Retries use exponential backoff with jitter, a capped attempt count, and idempotency keys.",
      "Reporting and batch jobs run on a replica or outside the write path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the deadlock log entry and identify the two lock orders.",
      "Find the blocker with `pg_blocking_pids` before touching a waiter.",
      "Check for sessions idle in transaction.",
      "Decide between waiting, canceling the statement, and terminating the session.",
      "Watch pool saturation and retry amplification while the queue drains.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the inconsistent lock order in code, not only in the runbook.",
      "Add the index that reduces rows locked by the slow statement.",
      "Tune timeouts and retry policy with measured queue behavior.",
      "Re-run the workload and confirm deadlocks and wait p95 stay below target.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Explicit Locking",
    url: "https://www.postgresql.org/docs/current/explicit-locking.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Row-level locks, deadlock detection, `deadlock_timeout`, and lock ordering.",
  },
  {
    title: "PostgreSQL: pg_locks",
    url: "https://www.postgresql.org/docs/current/view-pg-locks.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Lock modes, granted and waiting locks, and the sessions that hold them.",
  },
  {
    title: "PostgreSQL: Monitoring Statistics",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "`pg_stat_activity` sessions, wait events, and transaction state used to find blockers.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "locks-deadlocks": {
      model: locksModel,
      presets,
      instructions:
        "Start Healthy, apply Deadlock storm, then enable consistent lock order and jittered retries one at a time. Compare deadlocks with retry amplification.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Wait times, deadlock counts, and thresholds are teaching values, not PostgreSQL benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-long-transactions",
    "databases-query-plans",
    "databases-indexing",
    "databases-primary-replica-lag",
    "reliability-db-failover",
  ],
};
