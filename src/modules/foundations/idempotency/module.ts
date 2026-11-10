import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RETRY_DELAY_SEC = 120;
const COMMIT_SHARE = 0.7;

const params: ParamSpec[] = [
  {
    id: "keyCoveragePct",
    label: "Requests with a key",
    min: 0,
    max: 100,
    step: 1,
    value: 100,
    unit: "%",
    group: "Key coverage",
    help: "Share of payment requests that carry a client-generated idempotency key.",
    format: "percent",
  },
  {
    id: "retryAttempts",
    label: "Retry attempts",
    min: 0,
    max: 5,
    step: 1,
    value: 2,
    unit: "",
    group: "Retry policy",
    help: "Additional attempts after a timeout. Each failed retry is another chance to repeat the side effect.",
    format: "count",
  },
  {
    id: "timeoutRatePct",
    label: "Ambiguous timeout rate",
    min: 0,
    max: 30,
    step: 0.5,
    value: 8,
    unit: "%",
    group: "Failure",
    help: "Requests where the provider call times out after it may already have committed the charge.",
    format: "percent",
  },
  {
    id: "dedupeWindowMin",
    label: "Key retention",
    min: 1,
    max: 120,
    step: 1,
    value: 30,
    unit: " min",
    group: "Key store",
    help: "How long the key and its stored response survive. The retry delay in this scenario is 120 seconds.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  coverage: number;
  attempts: number;
  timeoutRate: number;
  windowMin: number;
  expired: boolean;
  protectedShare: number;
  duplicateRate: number;
  duplicatesPer10k: number;
  keyHitRate: number;
  amplification: number;
}

function compute(p: Params): Computed {
  const coverage = num(p, "keyCoveragePct", 100) / 100;
  const attempts = Math.round(num(p, "retryAttempts", 2));
  const timeoutRate = num(p, "timeoutRatePct", 8) / 100;
  const windowMin = Math.round(num(p, "dedupeWindowMin", 30));
  const expired = windowMin * 60 < RETRY_DELAY_SEC;
  const protectedShare = expired ? 0 : coverage;
  const duplicateRate = timeoutRate * attempts * (1 - protectedShare) * COMMIT_SHARE;
  return {
    coverage,
    attempts,
    timeoutRate,
    windowMin,
    expired,
    protectedShare,
    duplicateRate,
    duplicatesPer10k: duplicateRate * 10_000,
    keyHitRate: protectedShare * 100,
    amplification: 1 + timeoutRate * attempts,
  };
}

function healthFor(duplicateRate: number): "ok" | "warn" | "crit" {
  if (duplicateRate * 100 >= 2) return "crit";
  if (duplicateRate * 100 >= 0.5) return "warn";
  return "ok";
}

function buildFrame(p: Params, state: number | undefined, seed: number): SimFrame {
  const values = compute(p);
  const duplicateRate = state === undefined ? values.duplicateRate : state;
  const health = healthFor(duplicateRate);
  const keyHealth =
    values.coverage === 0 ? "ok" : values.expired ? "crit" : values.protectedShare < 0.9 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${values.attempts + 1} attempt max`,
        meta: { view: "flow" },
      },
      {
        id: "api",
        label: "Payments API",
        kind: "service",
        health,
        utilization: clamp(duplicateRate / 0.3),
        throughput: 1_000,
        sublabel: `${(duplicateRate * 100).toFixed(1)}% duplicated`,
        meta: { view: "flow" },
      },
      {
        id: "keys",
        label: "Idempotency store",
        kind: "storage",
        health: keyHealth,
        utilization: clamp(values.protectedShare),
        sublabel: `${values.keyHitRate.toFixed(0)}% key hit rate`,
        detail:
          values.coverage === 0
            ? `No requests carry a key, so the store cannot deduplicate. Retention ${values.windowMin} minutes; retry delay ${RETRY_DELAY_SEC} seconds.`
            : `Retention ${values.windowMin} minutes; retry delay ${RETRY_DELAY_SEC} seconds; ${values.expired ? "keys expire before the retry" : "keys outlive the retry"}.`,
        meta: { view: "flow" },
      },
      {
        id: "processor",
        label: "Charge processor",
        kind: "service",
        health,
        utilization: clamp(duplicateRate / 0.3),
        throughput: 1_000,
        sublabel: `${(duplicateRate * 60_000).toFixed(0)} duplicate/min`,
        meta: { view: "flow" },
      },
      {
        id: "provider",
        label: "Card provider",
        kind: "external",
        health: "ok",
        sublabel: "commits, then times out",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-api", "client", "api", 0.8, health),
      edge("api-keys", "api", "keys", 0.7, keyHealth),
      edge("api-processor", "api", "processor", 0.8, health),
      edge("processor-provider", "processor", "provider", 0.8, "ok"),
    ],
    metrics: [
      metric("duplicate-rate", "Duplicate charge rate", duplicateRate * 100, "%", 0.05, 0.2, "percent"),
      metric("duplicates-per-10k", "Duplicate charges per 10k", duplicateRate * 10_000, "", 5, 20, "count"),
      metric("key-hit-rate", "Key hit rate", values.keyHitRate, "%", undefined, undefined, "percent"),
      metric("timeout-rate", "Ambiguous timeout rate", values.timeoutRate * 100, "%", undefined, undefined, "percent"),
      metric("amplification", "Retry amplification", values.amplification, "x", undefined, undefined, "number"),
      metric("duplicates-minute", "Duplicate charges per minute", duplicateRate * 60_000, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      duplicateRate,
      paramsKey: JSON.stringify(p),
    },
    summary: `${(duplicateRate * 100).toFixed(2)}% duplicate charges; ${values.keyHitRate.toFixed(0)}% key hit rate; ${values.coverage === 0 ? "no key coverage" : values.expired ? "keys expire before retry" : "keys cover the retry"}.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 12 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.6) * Math.max(0.2, item.value * 0.015);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "duplicate-rate",
    metricId: "duplicate-rate",
    warn: 0.05,
    crit: 0.2,
    title: "Duplicate charge rate crossed the critical threshold",
    cause:
      "A timed-out write is being retried without a usable dedupe record. The provider may have committed the first attempt, so every retry can create a second financial effect.",
    fix:
      "Stop blind retries first. Add a client idempotency key, reserve it before the charge, and return the stored result for every retry of the same logical operation.",
    checkFirst: [
      "Confirm which retries lack a key and whether the key store was reachable on the first attempt.",
      "Check the key retention window against the retry delay.",
      "Check the provider's own idempotency support and reconciliation report.",
    ],
  },
  {
    id: "duplicates-per-10k",
    metricId: "duplicates-per-10k",
    warn: 5,
    crit: 20,
    title: "Duplicate charges are reaching customers",
    cause:
      "The duplicate rate is high enough to create a visible billing incident. The cause is an ambiguous timeout plus at least one retry path that cannot prove the first effect already happened.",
    fix:
      "Disable automatic retries for the affected path, reconcile against the provider, and refund duplicates. Then implement an atomic key reservation and a stored response before re-enabling retries.",
    checkFirst: [
      "Compare the provider ledger with your order ledger for the affected window.",
      "Identify the retry path and its dedupe key coverage.",
      "Check whether the first request was still in flight when the retry arrived.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const idempotencyModel: SimModel = {
  id: "foundations-idempotency",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), undefined, seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt) => {
    const target = compute(p);
    const previous = Number(frame.flags.duplicateRate ?? 0);
    const smoothing = Math.min(1, dt / 2);
    const duplicateRate = previous + (target.duplicateRate - previous) * smoothing;
    const next = buildFrame(p, duplicateRate, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (duplicateRate >= 0.002 && frame.flags.duplicateEvent !== 1) {
      pushEvent(next, {
        id: "duplicate-charge",
        at: frame.t,
        severity: "crit",
        title: "A retry created a second charge",
        detail: `The duplicate rate is ${(duplicateRate * 100).toFixed(2)}%. The first attempt timed out after a possible commit, and the retry had no usable dedupe record.`,
        metricId: "duplicate-rate",
        nodeId: "processor",
      });
      next.flags.duplicateEvent = 1;
    }
    if (duplicateRate < 0.0005) next.flags.duplicateEvent = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `About ${(values.timeoutRate * 100).toFixed(1)}% of calls time out ambiguously; ${(COMMIT_SHARE * 100).toFixed(0)}% of those may already have committed in this scenario.`,
      `With ${(values.coverage * 100).toFixed(0)}% key coverage, ${values.duplicateRate >= 0.002 ? "the duplicate rate is above the critical line" : "the duplicate rate stays bounded"} at ${(values.duplicateRate * 100).toFixed(2)}%.`,
      values.coverage === 0
        ? "No requests carry a key, so the store cannot deduplicate regardless of its retention window."
        : values.expired
          ? `Keys are retained ${values.windowMin} minutes but the retry arrives after ${RETRY_DELAY_SEC / 60} minutes, so the store cannot deduplicate.`
          : `Keys outlive the ${RETRY_DELAY_SEC / 60}-minute retry delay, so a stored result can be returned.`,
      `The retry path adds ${(values.amplification - 1).toFixed(2)} attempts per original before duplicates are counted.`,
      "The key must be reserved before the side effect. A key looked up only after the charge is too late for the first race.",
    ];
  },
  legend: [
    { label: "Protected", tone: "ok" },
    { label: "Partial coverage", tone: "warn" },
    { label: "Duplicate effect", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Full key coverage, one retry, low timeout rate, and keys retained longer than the retry.",
    tone: "ok",
    params: defaults({ keyCoveragePct: 100, retryAttempts: 1, timeoutRatePct: 3, dedupeWindowMin: 60 }),
  },
  {
    id: "peak",
    label: "Partial coverage",
    description: "Most requests carry a key, but the uncovered tail still produces a small duplicate rate.",
    tone: "warn",
    params: defaults({ keyCoveragePct: 98, retryAttempts: 1, timeoutRatePct: 8, dedupeWindowMin: 30 }),
  },
  {
    id: "failure",
    label: "Retry without a key",
    description: "No key coverage and three retries. A timed-out charge that committed is charged again.",
    tone: "crit",
    params: defaults({ keyCoveragePct: 0, retryAttempts: 3, timeoutRatePct: 12, dedupeWindowMin: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Full key coverage and a store that outlives the retry. Duplicates stop.",
    tone: "ok",
    params: defaults({ keyCoveragePct: 100, retryAttempts: 3, timeoutRatePct: 12, dedupeWindowMin: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-duplicate-charges",
  title: "Predict the duplicate charge rate",
  simId: "payments",
  question:
    "Twelve percent of charges time out ambiguously. The client retries three times with no idempotency key. How many duplicate charges appear per 10,000 payments?",
  prediction: {
    options: [
      { id: "none", label: "Zero, because the timeout means the charge did not commit" },
      { id: "low", label: "About 250 per 10,000" },
      { id: "high", label: "About 2,500 per 10,000" },
      { id: "all", label: "About 12,000 per 10,000" },
    ],
    correctOptionId: "high",
    explanation:
      "Twelve percent time out, three retries follow, and 70% of timed-out charges had already committed in this illustrative model. That is 0.12 times 3 times 0.7, or 25.2%, which is about 2,520 duplicates per 10,000. A timeout is an observation about the response, not proof that the effect did not happen.",
  },
  setup: defaults({ keyCoveragePct: 0, retryAttempts: 3, timeoutRatePct: 12, dedupeWindowMin: 30 }),
  runFor: 10,
  observe: [
    "The duplicate rate settles near 25% because every retry of a committed timeout can charge again.",
    "Key hit rate is zero, so the store provides no protection.",
    "Retry amplification is modest compared with the financial impact; the damage is in the effect, not the request count.",
    "The provider stays healthy. This is your bug, not the provider's outage.",
  ],
  explain:
    "A timeout is ambiguous: the request may have failed before the commit, or it may have committed and lost the response. Retrying without a key guesses that it failed. The key converts the guess into a lookup: if the operation already happened, return the stored result; if it is still in flight, reject the concurrent retry instead of charging again.",
  fix: defaults({ keyCoveragePct: 100, retryAttempts: 3, timeoutRatePct: 12, dedupeWindowMin: 30 }),
  debrief:
    "With full key coverage and a retention window longer than the retry delay, the duplicate rate falls to zero. The retries still happen, and the timeout rate is unchanged; what changes is that each retry returns the original result instead of creating a second charge. The remaining work is the key store, the concurrent-request behavior, and a retention policy longer than the longest retry horizon.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An operation is idempotent when repeating it produces the same effect as performing it once. A read is naturally idempotent. A payment charge is not: each successful call can move money. An idempotency key makes a retried write safe by giving the server a stable identity for the logical operation. The client generates the key once, sends it on the first attempt, and sends the same key on every retry.",
  },
  {
    type: "p",
    text: "The server uses the key in three steps: reserve it atomically before doing work, store the outcome, and return the stored outcome for any later request with the same key. If a second request arrives while the first is still in flight, the server should return a conflict or in-progress response rather than start a second effect. The key is not a request ID generated per attempt; that would defeat the purpose.",
  },
  {
    type: "p",
    text: "An ambiguous timeout is the hard case. The client sees no response, but the provider may have committed the charge before the connection broke. Retrying without a key can duplicate the charge; not retrying can lose the sale. The key resolves the ambiguity because the server, not the client, remembers whether the effect happened.",
  },
  {
    type: "p",
    text: "Delivery is usually at-least-once. Exactly-once delivery across arbitrary networks and providers is not a general guarantee. What you can build is exactly-once effects: at-least-once delivery plus an idempotent handler. Say it that way in a design review, because the difference is where the bugs live.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The key path runs from the client through the payments API to a durable key store, then to the charge processor and the external provider. The store must be durable and shared by every API instance; an in-memory map only protects the instance that saw the first attempt. The provider may also support its own idempotency key, which is a second layer, not a substitute for yours.",
  },
  {
    type: "table",
    headers: ["Design", "Retry safety", "Failure mode"],
    rows: [
      ["No key", "Unsafe", "Every retry can create a second effect"],
      ["In-memory key", "Only on one instance", "Retry lands on another instance or after a deploy"],
      ["Durable key, lookup after charge", "Partial", "Concurrent retries race before the record exists"],
      ["Durable key, reserve before charge", "Safe within retention", "Retry after expiry can duplicate"],
      ["Naturally idempotent write", "Safe", "Not available for charges, emails, or inventory decrements"],
    ],
  },
  {
    type: "p",
    text: "Retention is part of the contract. A key must outlive the longest plausible retry horizon, including client backoff, queue redelivery, and manual replay. In this model the retry delay is fixed at 120 seconds and the retention slider runs from 1 to 120 minutes, so you can make the store expire before the retry. Real systems often retain keys for 24 hours or longer; the teaching values are compressed so the failure is visible.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Duplicate charge rate: the share of payments that produce a second effect.",
      "Duplicate charges per 10,000: the same signal in a unit finance can act on.",
      "Key hit rate: whether a retry can find the original result inside the retention window.",
      "Ambiguous timeout rate and retry attempts: the inputs that create the exposure.",
      "A key store node that turns red when keys expire before the retry arrives.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Retry without a key. Watch the duplicate meter rise while the provider stays healthy. Shorten the key retention below two minutes with full coverage and observe that the store no longer protects the retry. Run the experiment before reading the explanation, then apply the fix.",
  },
  { type: "sim", simId: "payments" },
  { type: "experiment", experimentId: "predict-duplicate-charges" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The provider timed out after committing some charges. Without a key, each retry was a new logical charge, so the duplicate rate grew with the timeout rate and the number of attempts. The provider's health was irrelevant: it had done exactly what it was asked to do, twice.",
  },
  {
    type: "p",
    text: "With a durable key reserved before the charge, the first attempt owned the operation. Retries found the stored result and returned it instead of charging again. When retention was shorter than the retry delay, the key disappeared and the protection disappeared with it. The key is only as good as its lifetime and its atomic reservation.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Provider API logs: repeated charges with the same order or customer reference, and a provider idempotency key that was absent or changed between attempts.",
      "API logs: timeout followed by a retry, a 409 conflict, or a second 2xx for the same logical operation. Log the key, not the raw card data.",
      "Database: an `idempotency_keys` table with a unique constraint on the key, a state such as pending or completed, a stored response, and an expiry timestamp.",
      "Stripe or another provider: the `Idempotency-Key` request header, stored response behavior, and the conflict response for a key reused with a different payload. Check the provider's retention policy against your retry horizon.",
      "Reconciliation: a daily comparison of provider charges against orders. Duplicate detection here is a backstop, not the primary control.",
      "Traces: two charge spans for one order, often with one slow first span and a fast retry.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Stop automatic retries for the affected write path. Check whether the first attempt committed by querying the provider or your ledger. Then check key coverage, key retention against the retry delay, and whether the key was reserved before the charge or only recorded after it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Disable blind retries for non-idempotent writes and reconcile the affected window.",
      "Generate the key on the client for one logical operation and reuse it across every retry.",
      "Reserve the key atomically with a unique constraint before calling the provider.",
      "Store the provider result and return the same response body and status for a repeated key.",
      "Return a conflict or in-progress response for a concurrent request with the same key.",
      "Set retention longer than the retry horizon, and document what happens after expiry.",
      "Monitor key hit rate, duplicate rate, and conflict rate, and alert on the first two.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The key store adds a write and a read to the critical path. That cost buys safety under an ambiguous failure.",
      "Longer retention costs storage and increases the chance that a client reuses a key for a different payload; reject that case explicitly.",
      "A strict conflict response is safer than waiting, but it pushes retry handling back to the client.",
      "Provider-side idempotency is useful and still not enough if your own service performs a second side effect before or after the provider call.",
      "Exactly-once effects depend on every side effect being covered, including emails, inventory, and ledger entries. A key on the charge alone does not make the whole workflow safe.",
      "Keys can contain or be derived from personal data. Store an opaque value and apply a retention policy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "ambiguous-timeout",
    question:
      "A payment request times out after 30 seconds. The client wants to retry. How do you decide whether it is safe?",
    difficulty: 2,
    hints: [
      "A timeout tells you about the response, not the effect.",
      "Look for a stable identity for the logical operation.",
    ],
    answer:
      "I would not treat the timeout as proof of failure. First I would check whether the request carried an idempotency key and whether the server can look up the outcome for that key. If the key exists and the operation completed, return the stored result. If it is still in flight, return a conflict or in-progress response instead of starting a second charge. If there is no key, I would query the provider or ledger by the business reference before retrying, and disable automatic retries until the path is safe. The decision is about the effect, not about whether the connection is still open.",
    followUps: [
      "What if the key exists but the stored response is a 500?",
      "How long do you keep the key?",
      "What do you do if the provider has no lookup API?",
    ],
    redFlags: [
      "Retries because the error was a timeout.",
      "Assumes a 5xx means nothing committed.",
      "Uses an in-memory dedupe map.",
    ],
    rubric: [
      "Separates response failure from effect failure.",
      "Uses a key or business reference to check.",
      "Handles in-flight concurrency.",
      "Names a reconciliation path.",
    ],
  },
  {
    id: "design-key-store",
    question:
      "Design the server-side idempotency store for a charge endpoint. What are the states, the constraints, and the response for a duplicate?",
    difficulty: 3,
    hints: [
      "Reserve before the side effect, not after.",
      "A concurrent duplicate is not the same as a completed duplicate.",
    ],
    answer:
      "The store has a unique key per logical operation, the request fingerprint, a state of pending or completed, the stored status and response body, and an expiry. The first request inserts a pending row with a unique constraint before calling the provider. If the insert loses the race, the second request reads the row: if completed, it returns the stored response; if pending, it returns a conflict or in-progress response. On completion, the row is updated with the result in the same transaction as the local ledger write where possible. Retention must exceed the retry horizon. The request fingerprint should be checked so a key reused with a different amount is rejected rather than returning the old result.",
    followUps: [
      "What if the process crashes after the provider call but before the update?",
      "How do you handle a key reused with a different body?",
      "Would you put the store in the same database as the ledger?",
    ],
    redFlags: [
      "Checks the key only after the charge.",
      "Returns the stored result for a different payload.",
      "Has no pending state.",
    ],
    rubric: [
      "Atomic reservation and unique constraint.",
      "Pending versus completed behavior.",
      "Stored response and fingerprint.",
      "Retention and crash recovery.",
    ],
  },
  {
    id: "exactly-once",
    question:
      "A teammate says the new queue gives exactly-once delivery, so the consumer does not need idempotency. What is wrong with that statement?",
    difficulty: 3,
    hints: [
      "Separate broker delivery from end-to-end effects.",
      "A crash can happen between the effect and the acknowledgement.",
    ],
    answer:
      "Exactly-once delivery is a broker-level claim about a message within a bounded system. The consumer still performs side effects that the broker cannot commit atomically with the message acknowledgement. A crash after the charge and before the ack causes redelivery, and the effect happens twice unless the handler is idempotent. The safe statement is at-least-once delivery with an idempotent consumer, plus a durable dedupe record or a naturally idempotent write. If the broker supports transactions that include the output write, that can narrow the gap, but it still depends on the sink and the boundary of the transaction.",
    followUps: [
      "What does a Kafka transaction actually cover?",
      "How would you make an email side effect idempotent?",
      "Where does the dedupe record live relative to the effect?",
    ],
    redFlags: [
      "Accepts the broker claim as end-to-end.",
      "Ignores the crash window.",
      "Has no dedupe record for the consumer.",
    ],
    rubric: [
      "Separates delivery from effect.",
      "Names the crash window.",
      "Requires an idempotent handler.",
      "Mentions transactional boundaries accurately.",
    ],
  },
  {
    id: "retention-window",
    question:
      "How do you choose the idempotency key retention window, and what happens when a retry arrives after it expires?",
    difficulty: 2,
    hints: [
      "Start from the longest retry path, including queues and manual replay.",
      "Expiry is a correctness boundary, not a cleanup detail.",
    ],
    answer:
      "I would set retention longer than the longest plausible retry horizon: client backoff, queue redelivery, deploy recovery, and any manual replay process. It should also cover the provider's own retry or settlement delay. When a retry arrives after expiry, the server can no longer prove the effect happened, so it must treat the request as new unless it has a second lookup such as a business reference. That is a duplicate risk, not a cache miss. The expiry policy should be documented, monitored, and tested with a retry that crosses the boundary.",
    followUps: [
      "What is a reasonable retention for a payment API?",
      "How would you detect a retry after expiry?",
      "Would you ever extend retention on lookup?",
    ],
    redFlags: [
      "Picks retention by storage cost alone.",
      "Treats an expired key as a normal miss.",
      "Ignores queue redelivery.",
    ],
    rubric: [
      "Derives retention from the retry horizon.",
      "Treats expiry as a correctness boundary.",
      "Names a secondary lookup.",
      "Mentions monitoring and testing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every non-idempotent write accepts a client key and enforces it with a unique constraint.",
      "The key is reserved before the side effect; a pending state exists for concurrent requests.",
      "The stored response includes the status and body returned to the client.",
      "Retention exceeds the longest retry horizon, including queues and manual replay.",
      "A reconciliation job compares the provider ledger with the local ledger.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Disable automatic retries on the affected write path.",
      "Check whether the first attempt committed before issuing any manual retry.",
      "Reconcile the affected window and identify duplicate effects.",
      "Refund or reverse duplicates with an auditable record.",
      "Preserve keys and provider responses for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm key coverage and retention against the actual retry path.",
      "Add a test for a timeout followed by a retry with the same key.",
      "Add a test for a concurrent duplicate with the same key.",
      "Review whether the provider's idempotency behavior matches the assumption.",
    ],
  },
];

const references = [
  {
    title: "Making retries safe with idempotent APIs",
    url: "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-apis/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Idempotency keys, retry safety, and duplicate side effects.",
  },
  {
    title: "Idempotent requests",
    url: "https://docs.stripe.com/api/idempotent_requests",
    publisher: "Stripe",
    kind: "docs" as const,
    note: "The Idempotency-Key header, stored responses, retention, and conflict behavior.",
  },
  {
    title: "Designing robust and predictable APIs with idempotency",
    url: "https://stripe.com/blog/idempotency",
    publisher: "Stripe",
    kind: "docs" as const,
    note: "Why network retries make idempotency a production requirement.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    payments: {
      model: idempotencyModel,
      presets,
      instructions:
        "Start Healthy, apply Retry without a key, and watch duplicates rise while the provider stays healthy. Then shorten key retention below the retry delay and compare. Run the experiment before reading its explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The retry delay is 120 seconds and 70% of timed-out charges are assumed to have committed; both are teaching assumptions, not provider behavior.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-timeouts",
    "foundations-retry-backoff-jitter",
    "streaming-outbox",
    "streaming-exactly-once",
  ],
};
