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

const LIFETIME_LIMIT_SECONDS = 60;
const CACHE_BUDGET_MB = 4_000;

const params: ParamSpec[] = [
  {
    id: "transactionSeconds",
    label: "Transaction lifetime",
    min: 1,
    max: 900,
    step: 1,
    value: 2,
    unit: "s",
    group: "Workload",
    help: "How long the application intends to keep the transaction open. MongoDB aborts transactions that exceed `transactionLifetimeLimitSeconds`, which defaults to 60 seconds.",
    format: "number",
  },
  {
    id: "documentCount",
    label: "Documents touched",
    min: 100,
    max: 100_000,
    step: 100,
    value: 500,
    unit: " docs",
    group: "Workload",
    help: "Documents read or written by one transaction. A large count holds a larger snapshot and touches more locks, but it is not a standalone size limit.",
    format: "count",
  },
  {
    id: "documentSizeKb",
    label: "Average document size",
    min: 0.5,
    max: 16,
    step: 0.5,
    value: 1,
    unit: " KB",
    group: "Workload",
    help: "Average document size. Multiplied by the document count, it estimates the transaction's working set in the WiredTiger cache.",
    format: "number",
  },
  {
    id: "concurrentTransactions",
    label: "Concurrent transactions",
    min: 10,
    max: 1_000,
    step: 10,
    value: 50,
    unit: "",
    group: "Workload",
    help: "Open transactions per second at the same time. Each one holds a snapshot and cache pages, so concurrency multiplies cache pressure.",
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
  transactionSeconds: number;
  documentCount: number;
  documentSizeKb: number;
  concurrent: number;
  transactionSizeMb: number;
  cachePressureMb: number;
  expired: boolean;
  cacheAbort: boolean;
  tooLarge: boolean;
  abortRate: number;
  conflictRate: number;
  primaryUtilization: number;
  committed: boolean;
}

function compute(p: Params, t: number): Computed {
  const transactionSeconds = clamp(num(p, "transactionSeconds", 2), 1, 900);
  const documentCount = clamp(num(p, "documentCount", 500), 0, 200_000);
  const documentSizeKb = clamp(num(p, "documentSizeKb", 1), 0.1, 16);
  const concurrent = clamp(num(p, "concurrentTransactions", 50), 0, 2_000);
  const transactionSizeMb = (documentCount * documentSizeKb) / 1_024;
  const cachePressureMb = transactionSizeMb * concurrent;
  const expired = transactionSeconds > LIFETIME_LIMIT_SECONDS;
  const cacheAbort = cachePressureMb > CACHE_BUDGET_MB;
  const tooLarge = transactionSizeMb > CACHE_BUDGET_MB;
  const conflictRate = concurrent * 0.02 + (documentCount / 10_000) * 2;
  const abortRate = cacheAbort || tooLarge || expired ? 100 : clamp(conflictRate * 0.5, 0, 10);
  const committed = !cacheAbort && !tooLarge && !expired && t >= transactionSeconds;

  return {
    transactionSeconds,
    documentCount,
    documentSizeKb,
    concurrent,
    transactionSizeMb,
    cachePressureMb,
    expired,
    cacheAbort,
    tooLarge,
    abortRate,
    conflictRate,
    primaryUtilization: clamp(cachePressureMb / CACHE_BUDGET_MB),
    committed,
  };
}

function health(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const cacheHealth = health(values.cachePressureMb, 3_000, 4_000);
  const appHealth = health(values.abortRate, 5, 20);
  const primaryHealth = cacheHealth === "crit" ? "crit" : health(values.conflictRate, 5, 20);
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application",
      kind: "client",
      health: appHealth,
      sublabel: `${Math.round(values.concurrent)} concurrent · ${values.abortRate.toFixed(0)}% aborts`,
      detail:
        "The application owns the session and decides how many operations belong in one transaction. A retry loop around an oversized transaction can keep the pressure on after the first abort.",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: primaryHealth,
      utilization: values.primaryUtilization,
      sublabel: `${values.transactionSizeMb.toFixed(1)} MB/txn · ${Math.round(values.conflictRate)} conflicts/s`,
      detail:
        "The primary coordinates the transaction, acquires locks, and maintains the snapshot. Long transactions hold resources and can conflict with other writers.",
      meta: { view: "flow", conflicts: values.conflictRate },
    },
    {
      id: "cache",
      label: "WiredTiger cache",
      kind: "cache",
      health: cacheHealth,
      utilization: values.primaryUtilization,
      sublabel: `${Math.round(values.cachePressureMb).toLocaleString()} MB held · 4,000 MB budget`,
      detail:
        "Uncommitted transactions keep versions and pages in the storage engine cache. If the working set cannot fit, the server aborts with `TransactionTooLargeForCache` or a write conflict.",
      meta: { view: "flow", heldMb: values.cachePressureMb },
    },
    {
      id: "secondary",
      label: "Secondary",
      kind: "db",
      role: "replica",
      health: "ok",
      sublabel: "applies committed writes",
      detail:
        "The secondary applies committed transaction writes through the oplog. It does not participate in the client's open transaction until commit.",
      meta: { view: "flow" },
    },
  ];

  const edges = [
    edge("app-primary", "app", "primary", values.primaryUtilization),
    edge("primary-cache", "primary", "cache", values.primaryUtilization, cacheHealth),
    edge("primary-secondary", "primary", "secondary", clamp(values.cachePressureMb / 8_000)),
  ];

  const state = values.cacheAbort
    ? "cache pressure abort"
    : values.expired
      ? "lifetime limit abort"
      : values.committed
        ? "committed"
        : "transaction open";
  const summary = `${state} · ${values.transactionSizeMb.toFixed(1)} MB/txn · ${Math.round(values.cachePressureMb).toLocaleString()} MB cache pressure · ${values.abortRate.toFixed(0)}% aborts`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric(
        "transaction-age",
        "Transaction lifetime",
        values.transactionSeconds,
        "s",
        45,
        60,
        "number",
      ),
      metric(
        "cache-pressure",
        "Cache pressure",
        values.cachePressureMb,
        " MB",
        3_000,
        4_000,
        "number",
      ),
      metric("abort-rate", "Aborted transactions", values.abortRate, "%", 5, 20, "percent"),
      metric("write-conflicts", "Write conflicts", values.conflictRate, "/s", 5, 20, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      cacheAbort: values.cacheAbort ? 1 : 0,
      expired: values.expired ? 1 : 0,
      committed: values.committed ? 1 : 0,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 5)) / 2.6);
  const rows: [string, number, number][] = [
    ["transaction-age", values.transactionSeconds, 0.02],
    ["cache-pressure", values.cachePressureMb, 0.2],
    ["abort-rate", values.abortRate, 0.1],
    ["write-conflicts", values.conflictRate, 0.02],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cache-pressure",
    metricId: "cache-pressure",
    warn: 3_000,
    crit: 4_000,
    title: "Open transactions are exhausting the WiredTiger cache",
    cause:
      "Each open transaction holds a snapshot of the data it read and the versions it wrote. With many concurrent transactions, the combined footprint can exceed the cache and force the server to abort a transaction with `TransactionTooLargeForCache`.",
    fix: "Reduce the number of documents per transaction, reduce concurrency, or split the work into smaller transactions. Abort abandoned transactions promptly and set a transaction lifetime your workload can finish within.",
    checkFirst: [
      "Check open transaction count and the cache bytes held by transactions.",
      "Check for `TransactionTooLargeForCache` or write conflict errors in the server log.",
      "Check whether one report or batch job opens many large transactions concurrently.",
    ],
  },
  {
    id: "abort-rate",
    metricId: "abort-rate",
    warn: 5,
    crit: 20,
    title: "Transactions are aborting",
    cause:
      "The transaction exceeded its lifetime, could not fit in cache, or lost a lock to a concurrent writer. Retrying the same transaction without changing its boundary repeats the abort.",
    fix: "Fix the boundary or the conflict source before adding retries. Retry only transient errors with a bounded budget, and make the operation idempotent so a retried commit is safe.",
    checkFirst: [
      "Check whether the abort is a lifetime, cache, or write conflict error.",
      "Check transaction size and the number of documents touched.",
      "Check whether the retry runs the same oversized transaction again.",
    ],
  },
  {
    id: "write-conflicts",
    metricId: "write-conflicts",
    warn: 5,
    crit: 20,
    title: "Concurrent transactions are fighting for the same documents",
    cause:
      "Transactions acquire locks when they write. Two transactions that update the same document can conflict; one aborts with a write conflict. Higher concurrency and wider document sets raise the chance.",
    fix: "Narrow the documents each transaction touches, order writes consistently, or move the counter or hot document out of the transaction. Retry the conflict with backoff.",
    checkFirst: [
      "Check which documents or collections the concurrent transactions share.",
      "Check for hot documents such as counters or account rows.",
      "Check whether retries are synchronized and amplifying the conflict.",
    ],
  },
  {
    id: "transaction-age",
    metricId: "transaction-age",
    warn: 45,
    crit: 60,
    title: "The transaction is approaching its lifetime limit",
    cause:
      "MongoDB aborts transactions that exceed `transactionLifetimeLimitSeconds`, which defaults to 60 seconds. A long transaction holds a snapshot and cache pages for its whole lifetime.",
    fix: "Shorten the transaction boundary, or move the long-running work out of the transaction. If a longer lifetime is truly required, change the server parameter deliberately and account for the cache and lock cost.",
    checkFirst: [
      "Check the application's transaction duration, not only the total request duration.",
      "Check whether work such as an external API call happens inside the transaction.",
      "Check `transactionLifetimeLimitSeconds` and any recent change to it.",
    ],
  },
];

export const transactionsModel: SimModel = {
  id: "mongodb-transactions",
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

    const jitter = rng.between(-0.15, 0.15) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "write-conflicts" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.abortRate >= 20 && !Number(next.flags.abortAnnounced ?? 0)) {
      pushEvent(next, {
        id: "transaction-abort",
        at: frame.t,
        severity: "crit",
        title: values.cacheAbort
          ? "Transaction aborted under cache pressure"
          : "Transaction exceeded its lifetime",
        detail: values.cacheAbort
          ? `The modeled working set is ${Math.round(values.cachePressureMb).toLocaleString()} MB against a 4,000 MB illustrative cache budget. MongoDB can abort an oversized transaction with TransactionTooLargeForCache.`
          : `The transaction is older than the default ${LIFETIME_LIMIT_SECONDS}s limit. MongoDB aborts it during periodic cleanup.`,
        nodeId: "cache",
        metricId: "cache-pressure",
      });
      next.flags.abortAnnounced = 1;
    }
    if (values.committed && !Number(next.flags.commitAnnounced ?? 0)) {
      pushEvent(next, {
        id: "transaction-committed",
        at: frame.t,
        severity: "info",
        title: "Short transaction committed",
        detail:
          "The transaction stayed inside its lifetime and cache budget and released its snapshot and locks.",
        nodeId: "primary",
      });
      next.flags.commitAnnounced = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `One transaction touches ${Math.round(values.documentCount).toLocaleString()} documents at ${values.documentSizeKb.toFixed(1)} KB each, about ${values.transactionSizeMb.toFixed(1)} MB. With ${Math.round(values.concurrent)} concurrent, the modeled cache footprint is ${Math.round(values.cachePressureMb).toLocaleString()} MB.`,
    );
    if (values.transactionSeconds > LIFETIME_LIMIT_SECONDS) {
      items.push(
        `The modeled lifetime is ${Math.round(values.transactionSeconds)}s. MongoDB's default limit is ${LIFETIME_LIMIT_SECONDS}s; a transaction that reaches it is aborted, not extended.`,
      );
    } else {
      items.push(
        `The modeled lifetime is ${Math.round(values.transactionSeconds)}s, inside the default ${LIFETIME_LIMIT_SECONDS}s limit. The risk here is size and concurrency, not the timer.`,
      );
    }
    if (values.cacheAbort) {
      items.push(
        "The cache pressure is above budget. The correct fix is a smaller transaction boundary or less concurrency, not a bigger retry budget.",
      );
    }
    items.push(
      "MongoDB 4.2 and later write separate oplog entries per transaction operation, so the old 16 MB total transaction limit no longer applies; each oplog entry still has the 16 MB BSON document limit.",
    );
    if (values.conflictRate >= 5) {
      items.push(
        `${Math.round(values.conflictRate)} modeled write conflicts/s. Conflicts abort one side, and retries can raise the conflict rate further.`,
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
      "A 2s transaction touches 500 small documents with 50 concurrent sessions. Fits comfortably in cache.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "A 45s transaction touches 8,000 documents with 250 concurrent sessions. Near the cache and conflict limits.",
    tone: "warn",
    params: defaults({
      transactionSeconds: 45,
      documentCount: 8_000,
      documentSizeKb: 2,
      concurrentTransactions: 250,
    }),
  },
  {
    id: "failure",
    label: "Ten-minute transaction",
    description:
      "A 600s transaction touches 50,000 documents at 4 KB with 600 concurrent sessions. Cache pressure is far over budget.",
    tone: "crit",
    params: defaults({
      transactionSeconds: 600,
      documentCount: 50_000,
      documentSizeKb: 4,
      concurrentTransactions: 600,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "A 3s transaction touches 200 documents with 40 concurrent sessions. The boundary is small and the cache stays calm.",
    tone: "ok",
    params: defaults({
      transactionSeconds: 3,
      documentCount: 200,
      documentSizeKb: 1,
      concurrentTransactions: 40,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-what-breaks",
  title: "What breaks first in a ten-minute transaction?",
  simId: "transactions",
  question:
    "A transaction runs for 10 minutes, touches 50,000 documents at 4 KB each, and runs 600 times concurrently. What aborts it first?",
  prediction: {
    options: [
      {
        id: "size",
        label: "The 16 MB total transaction size limit rejects it before it starts",
      },
      {
        id: "lifetime",
        label: "The 60-second default lifetime limit is the first limit it reaches",
      },
      {
        id: "cache",
        label:
          "Cache pressure from 600 concurrent snapshots aborts it with TransactionTooLargeForCache",
      },
      {
        id: "concern",
        label: "Majority write concern times out because the transaction is too large to replicate",
      },
    ],
    correctOptionId: "cache",
    explanation:
      "A 195 MB working set is large, but one transaction can fit in a cache. Six hundred open snapshots multiply that to more than 100 GB of modeled pressure, far beyond the cache budget. The server aborts with `TransactionTooLargeForCache` or a write conflict long before the 60-second lifetime cleanup. The 16 MB total transaction limit was removed in MongoDB 4.2; the 16 MB limit that remains applies to a single BSON document and a single oplog entry, not to the whole transaction.",
  },
  setup: defaults({
    transactionSeconds: 600,
    documentCount: 50_000,
    documentSizeKb: 4,
    concurrentTransactions: 600,
  }),
  runFor: 15,
  observe: [
    "The modeled cache pressure is over 100 GB, far above the 4,000 MB illustrative budget.",
    "Abort rate reaches 100% while the transaction's lifetime is still far from 60 seconds.",
    "The primary and cache nodes go critical together; the secondary stays healthy.",
    "Reducing concurrency or documents per transaction lowers pressure without changing the timer.",
  ],
  explain:
    "Transaction limits are not one number. MongoDB aborts transactions that exceed the configured lifetime, and it aborts transactions that cannot fit in the WiredTiger cache. The second failure is a resource problem: many large snapshots hold pages that other operations need. Splitting the work into smaller transactions is usually the right fix; raising the lifetime makes the resource problem worse.",
  fix: defaults({
    transactionSeconds: 3,
    documentCount: 500,
    documentSizeKb: 1,
    concurrentTransactions: 50,
  }),
  debrief:
    "Check the transaction boundary first: what must be atomic, and what can happen after commit? Then check open transaction count, cache pressure, write conflicts, and lifetime. If the boundary is genuinely large, reduce concurrency or batch the work. Do not treat a retry loop as a fix for a transaction that cannot fit.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB multi-document transaction groups reads and writes across documents, collections, databases, and shards into one atomic unit. The application starts it on a session, performs operations with that session, and commits or aborts. Inside the transaction, reads see a consistent snapshot and writes remain invisible to other sessions until commit.",
  },
  {
    type: "p",
    text: "Atomicity has a cost. An open transaction holds a snapshot, locks for documents it writes, and cache pages for the versions it reads and creates. MongoDB limits how long a transaction may stay open and aborts one that cannot fit in the storage engine cache. Those limits exist because a transaction is a resource holder, not a free wrapper around a batch job.",
  },
  {
    type: "p",
    text: "The default lifetime is controlled by `transactionLifetimeLimitSeconds`, which is 60 seconds. Expired transactions are aborted by a periodic cleanup process. Separately, a transaction that causes excessive WiredTiger cache pressure can abort with a write conflict, and one too large to ever fit returns `TransactionTooLargeForCache`. Since MongoDB 4.2, transactions write separate oplog entries, so the old 16 MB total transaction limit is gone; each oplog entry still has the 16 MB BSON document limit.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The transaction lives between the application's session and the primary. The primary coordinates locks and commit; the storage engine holds the snapshot and versions; secondaries apply the committed result through the oplog. A transaction that runs for minutes keeps the primary's resources occupied while the rest of the application keeps writing.",
  },
  {
    type: "table",
    headers: ["Limit or resource", "What it constrains", "Typical symptom"],
    rows: [
      [
        "`transactionLifetimeLimitSeconds`",
        "How long a transaction may stay open",
        "Abort during periodic cleanup after the default 60s",
      ],
      [
        "WiredTiger cache",
        "How many snapshots and versions can be held",
        "`TransactionTooLargeForCache` or write conflict",
      ],
      [
        "Locks",
        "Which documents concurrent writers may change",
        "Write conflict on a hot document",
      ],
      [
        "16 MB BSON document limit",
        "One document and one oplog entry",
        "Document too large; not a total transaction limit",
      ],
    ],
  },
  {
    type: "compare",
    leftTitle: "Short transaction",
    rightTitle: "Long transaction",
    rows: [
      {
        label: "Boundary",
        left: "One business invariant",
        right: "A report, batch job, or external call",
      },
      {
        label: "Cache",
        left: "Small snapshot, released quickly",
        right: "Large snapshot held for the whole run",
      },
      {
        label: "Conflicts",
        left: "Few locks and a short window",
        right: "Locks held longer, more retries",
      },
      {
        label: "Failure",
        left: "Retry the unit safely",
        right: "Expiry or cache abort repeats on retry",
      },
    ],
  },
  {
    type: "p",
    text: "A transaction is the right tool when several documents must change together: a transfer, an inventory reservation, an order and its line items. It is the wrong tool for a long-running report, an external API call, or a batch that could be split. The document model often removes the need for a transaction by embedding related data in one document, where a single-document write is already atomic.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Transaction lifetime: how close the modeled transaction is to the 60s default limit.",
      "Cache pressure: the modeled snapshot footprint of all concurrent transactions.",
      "Aborted transactions: the share that exceed lifetime, size, or lock capacity.",
      "Write conflicts: how often concurrent transactions fight over the same documents.",
      "A short transaction that commits and releases its snapshot; a long one that cannot.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Ten-minute transaction. Watch cache pressure go critical before the lifetime timer does. Reduce the document count and concurrency separately to see which one drives the abort. Use the experiment to predict the first failure, then apply the fix and compare.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "The limit is not only the clock",
    body: "A transaction that finishes in 30 seconds can still fail if its snapshot does not fit in cache. Raising `transactionLifetimeLimitSeconds` gives a large transaction more time to hold resources; it does not give it more cache. Fix the boundary before changing the limit.",
  },
  { type: "sim", simId: "transactions" },
  { type: "experiment", experimentId: "predict-what-breaks" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The transaction tried to hold a 195 MB working set while 600 other transactions did the same. The modeled cache pressure crossed the budget long before the 60-second lifetime cleanup. The primary and cache went critical, the abort rate reached 100%, and retrying the same transaction would repeat the failure.",
  },
  {
    type: "p",
    text: "Shrinking the transaction to 500 small documents and 50 concurrent sessions removed the pressure. The lifetime was already short, so the timer was never the real constraint. The resource cost, not the document count by itself, decided the outcome.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`TransactionTooLargeForCache` or write conflict errors in the server log.",
      "Open transaction count and transaction cache bytes rising together.",
      "Primary CPU and cache eviction pressure rising while secondaries look healthy.",
      "Application retries repeating the same transaction and the same abort.",
      "A 60-second abort for transactions that simply never finish their work.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the transaction boundary and the number of documents it touches. Then check concurrent open transactions, cache pressure, and the server error type. If the error is a write conflict, find the shared hot document. If it is `TransactionTooLargeForCache`, the working set is too large for the concurrency, not just for the clock.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the smallest unit that must be atomic and move everything else outside the transaction.",
      "Reduce documents per transaction and the number of concurrent large transactions.",
      "Abort abandoned transactions and set a lifetime the real workload can meet.",
      "Retry only transient errors, with bounded backoff and idempotent effects.",
      "If a large boundary is unavoidable, batch it, reduce concurrency, and measure cache pressure.",
      "Change `transactionLifetimeLimitSeconds` only with the cache and lock cost understood.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shorter transaction is easier to retry but may require compensating work outside the atomic unit.",
      "A longer lifetime can finish a slow transaction but holds locks and cache pages longer.",
      "More concurrency raises throughput until cache pressure and write conflicts reverse it.",
      "Embedding related data avoids a transaction but can create large documents and update contention.",
      "Retrying a conflict is safe only when the operation is idempotent and the retry budget is bounded.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "boundary",
    question: "How do you decide whether an operation needs a multi-document transaction?",
    difficulty: 3,
    hints: [
      "Start from the invariant that must hold.",
      "A single-document write is already atomic.",
      "Long external work does not belong inside the boundary.",
    ],
    answer:
      "I start from the invariant: which documents must change together or not at all? If the invariant fits in one document, the document model already gives atomicity and a transaction adds cost. If it spans documents, I keep the transaction to the smallest set of reads and writes that enforces it, and move external calls, notifications, and reports outside. I also check whether the boundary can be redesigned so the invariant lives in one document.",
    followUps: [
      "When would you embed instead of transact?",
      "How do you handle a side effect after commit?",
      "What makes a transaction boundary too large?",
    ],
    redFlags: [
      "Wraps an entire request in a transaction by default.",
      "Calls an external API inside the transaction.",
      "Ignores single-document atomicity.",
    ],
    rubric: [
      "Starts from an invariant.",
      "Keeps the boundary small.",
      "Moves external work outside.",
      "Considers the document model.",
    ],
  },
  {
    id: "limits",
    question: "What are the real limits on a MongoDB transaction, and which one bites first?",
    difficulty: 3,
    hints: [
      "Lifetime and cache are different limits.",
      "The old 16 MB total limit is not current.",
      "Concurrency multiplies cache pressure.",
    ],
    answer:
      "The default lifetime is 60 seconds via `transactionLifetimeLimitSeconds`; expired transactions are aborted by periodic cleanup. WiredTiger cache is the other limit: an uncommitted transaction holds a snapshot and versions, and excessive pressure can abort it with a write conflict or `TransactionTooLargeForCache`. Since MongoDB 4.2, transactions write separate oplog entries, so there is no 16 MB total transaction limit; each BSON document and oplog entry still has a 16 MB limit. Which bites first depends on workload: a long but small transaction hits the timer, while many large concurrent transactions hit cache first.",
    followUps: [
      "What does `TransactionTooLargeForCache` mean?",
      "Why does concurrency matter more than one transaction's size?",
      "When would you change the lifetime parameter?",
    ],
    redFlags: [
      "Claims a hard 16 MB total transaction limit today.",
      "Confuses the document limit with the transaction limit.",
      "Says the lifetime limit is the only limit.",
    ],
    rubric: [
      "Names the 60s default.",
      "Explains cache pressure.",
      "Corrects the 16 MB total-limit claim.",
      "Relates concurrency to cache.",
    ],
  },
  {
    id: "abort",
    question: "A transaction aborts with a write conflict. What do you do before adding a retry?",
    difficulty: 3,
    hints: [
      "Find the shared document or lock.",
      "Retries can amplify the conflict.",
      "Ordering and boundary both matter.",
    ],
    answer:
      "I find which documents the conflicting transactions share and why they overlap. I would narrow the boundary, order writes consistently, or move a hot counter out of the transaction. Then I add a bounded retry with backoff for transient conflicts, and make the operation idempotent. Retrying blindly can synchronize the same transactions again and raise the conflict rate.",
    followUps: [
      "How do you make the retry idempotent?",
      "What is a hot document in this context?",
      "When is a write conflict a sign of a bad schema?",
    ],
    redFlags: [
      "Adds an infinite retry loop.",
      "Retries without finding the shared document.",
      "Assumes the conflict is a network error.",
    ],
    rubric: [
      "Finds the conflict source.",
      "Narrows or reorders writes.",
      "Bounds retries.",
      "Makes effects idempotent.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every multi-document transaction has a named invariant and a bounded set of documents.",
      "No external call or long report runs inside a transaction.",
      "Transaction lifetime, cache pressure, abort rate, and write conflicts are on a dashboard.",
      "Retries are bounded and the operation is idempotent.",
      "The application aborts abandoned transactions instead of leaving them to expire.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify whether the abort is lifetime, cache, or write conflict.",
      "Check concurrent open transactions and cache bytes, not only one transaction's size.",
      "Stop retry storms before changing server parameters.",
      "Reduce concurrency or transaction size rather than extending the lifetime first.",
      "Check the secondary only for commit or replication symptoms; it is not holding the open snapshot.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the transaction boundary and document count are back within budget.",
      "Check that aborts and conflicts have returned to baseline.",
      "Review whether a schema change could remove the need for the transaction.",
      "Document any lifetime parameter change and its cache cost.",
    ],
  },
];

const references = [
  {
    title: "Transactions",
    url: "https://www.mongodb.com/docs/manual/core/transactions/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Multi-document transactions, sessions, commit and abort behavior.",
  },
  {
    title: "Transactions Production Considerations",
    url: "https://www.mongodb.com/docs/manual/core/transactions-production-consideration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Runtime limits, oplog size, WiredTiger cache pressure, and TransactionTooLargeForCache.",
  },
  {
    title: "transactionLifetimeLimitSeconds",
    url: "https://www.mongodb.com/docs/manual/reference/parameters/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "The 60-second default lifetime and the periodic cleanup that aborts expired transactions.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    transactions: {
      model: transactionsModel,
      presets,
      instructions:
        "Start Healthy, then apply Ten-minute transaction. Watch cache pressure cross the budget before the lifetime timer. Reduce documents and concurrency separately to find which one drives the abort.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Cache budget, conflict rate, and abort timing are teaching values; MongoDB's documented default transaction lifetime is 60 seconds.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-write-concern", "mongodb-retryable-writes", "mongodb-read-concern"],
};
