import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 10_000;
const PAYMENT_SHARE = 0.25;
const PAYMENT_RPS = TOTAL_RPS * PAYMENT_SHARE;
const OTHER_RPS = TOTAL_RPS - PAYMENT_RPS;
const PROVIDER_CAPACITY = 5_000;
const PROVIDER_TIMEOUT_MS = 1_200;
const CHECKOUT_BASE_MS = 250;

const params: ParamSpec[] = [
  {
    id: "providerErrorRatePct",
    label: "Provider error rate",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Provider",
    help: "Share of payment calls the third party rejects immediately.",
    format: "percent",
  },
  {
    id: "providerLatencyMs",
    label: "Provider latency",
    min: 100,
    max: 8_000,
    step: 100,
    value: 300,
    unit: " ms",
    group: "Provider",
    help: "Response time of the payment provider. Calls above the 1.2s timeout fail even when the provider eventually answers.",
    format: "ms",
  },
  {
    id: "isolationPct",
    label: "Bulkhead isolation",
    min: 0,
    max: 100,
    step: 10,
    value: 90,
    unit: "%",
    group: "Containment",
    help: "Share of provider calls that use a dedicated connection pool and concurrency limit. The rest share resources with unrelated flows.",
    format: "percent",
  },
  {
    id: "fallbackPct",
    label: "Fallback coverage",
    min: 0,
    max: 100,
    step: 10,
    value: 100,
    unit: "%",
    group: "Containment",
    help: "Share of failed payment attempts handled by a designed path such as deferred capture, an alternate provider, or a clear retry-later response.",
    format: "percent",
  },
  {
    id: "retryAttempts",
    label: "Retries per failed payment",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Retry policy",
    help: "Additional attempts after a failure. Every retry adds load to the failing provider.",
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
  errorRate: number;
  latency: number;
  isolation: number;
  fallback: number;
  retries: number;
  timeoutShare: number;
  providerFail: number;
  providerLoad: number;
  providerUtil: number;
  checkoutErrors: number;
  unrelatedErrors: number;
  checkoutP99: number;
  fallbackServed: number;
  retryLoad: number;
}

function compute(p: Params): Computed {
  const errorRate = clamp(num(p, "providerErrorRatePct", 0), 0, 100) / 100;
  const latency = Math.max(100, num(p, "providerLatencyMs", 300));
  const isolation = clamp(num(p, "isolationPct", 90), 0, 100) / 100;
  const fallback = clamp(num(p, "fallbackPct", 100), 0, 100) / 100;
  const retries = clamp(Math.round(num(p, "retryAttempts", 0)), 0, 3);
  const timeoutShare = latency > PROVIDER_TIMEOUT_MS ? 1 : 0;
  const baseFail = Math.max(errorRate, timeoutShare);
  const retryLoad = PAYMENT_RPS * baseFail * retries;
  const providerLoad = PAYMENT_RPS + retryLoad;
  const providerUtil = providerLoad / PROVIDER_CAPACITY;
  const overloadFail = clamp((providerUtil - 1) * 0.4, 0, 0.9);
  const providerFail = clamp(Math.max(baseFail, overloadFail), 0, 1);
  const checkoutErrors = providerFail * (1 - fallback) * 100;
  const unrelatedErrors = (1 - isolation) * providerFail * 25;
  const checkoutP99 =
    CHECKOUT_BASE_MS + (1 - fallback) * Math.min(latency, PROVIDER_TIMEOUT_MS) + fallback * 50;
  return {
    errorRate,
    latency,
    isolation,
    fallback,
    retries,
    timeoutShare,
    providerFail,
    providerLoad,
    providerUtil,
    checkoutErrors,
    unrelatedErrors,
    checkoutP99,
    fallbackServed: PAYMENT_RPS * providerFail * fallback,
    retryLoad,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seedValue: number, t: number): SimFrame {
  const checkoutHealth: "ok" | "warn" | "crit" =
    c.checkoutErrors >= 2 || c.checkoutP99 >= PROVIDER_TIMEOUT_MS
      ? "crit"
      : c.checkoutErrors >= 0.5 || c.checkoutP99 >= 800
        ? "warn"
        : "ok";
  const unrelatedHealth = healthFor(c.unrelatedErrors, 0.5, 2);
  const providerHealth: "ok" | "warn" | "crit" =
    c.providerFail >= 0.5 || c.providerUtil >= 0.95
      ? "crit"
      : c.providerFail > 0.05 || c.providerUtil > 0.8
        ? "warn"
        : "ok";
  const fallbackHealth: "ok" | "warn" | "down" =
    c.fallback >= 1 ? "ok" : c.fallback > 0 ? "warn" : "down";
  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Shopper",
        kind: "client",
        health: "ok",
        sublabel: "cart and checkout",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: checkoutHealth,
        utilization: clamp(c.checkoutErrors / 100),
        throughput: PAYMENT_RPS,
        sublabel: `${c.checkoutErrors.toFixed(1)}% payment errors`,
        detail: `Payment calls are ${Math.round(PAYMENT_SHARE * 100)}% of 10k rps. Fallback covers ${Math.round(c.fallback * 100)}% of failed attempts.`,
        meta: { view: "flow" },
      },
      {
        id: "provider",
        label: "Payment provider",
        kind: "external",
        health: providerHealth,
        utilization: clamp(c.providerUtil),
        throughput: Math.min(c.providerLoad, PROVIDER_CAPACITY),
        sublabel: `${Math.round(c.providerLoad).toLocaleString("en-US")} rps offered`,
        detail: `Illustrative capacity is ${PROVIDER_CAPACITY.toLocaleString("en-US")} rps. Retries add ${Math.round(c.retryLoad).toLocaleString("en-US")} rps to the provider.`,
        meta: { view: "flow" },
      },
      {
        id: "fallback",
        label: "Payment fallback",
        kind: "cache",
        health: fallbackHealth,
        utilization: clamp(c.fallback),
        throughput: c.fallbackServed,
        sublabel:
          c.fallback >= 1
            ? "explicit fallback"
            : c.fallback > 0
              ? "partial coverage"
              : "no fallback",
        detail:
          "A deferred capture, an alternate provider, or a clear retry-later response. The fallback must have its own failure mode and its own alert.",
        meta: { view: "flow" },
      },
      {
        id: "unrelated",
        label: "Unrelated flows",
        kind: "service",
        health: unrelatedHealth,
        utilization: clamp(c.unrelatedErrors / 100),
        throughput: OTHER_RPS,
        sublabel: `${c.unrelatedErrors.toFixed(1)}% errors`,
        detail:
          "Browse, search, account, and support flows that do not need the payment provider. They should not fail because a shared pool is exhausted.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-checkout", "client", "checkout", 1, checkoutHealth),
      edge("checkout-provider", "checkout", "provider", clamp(c.providerUtil), providerHealth),
      edge("checkout-fallback", "checkout", "fallback", clamp(c.fallback), fallbackHealth),
      edge("client-unrelated", "client", "unrelated", 0.75, unrelatedHealth),
    ],
    metrics: [
      metric(
        "checkout-errors",
        "Checkout payment errors",
        c.checkoutErrors,
        "%",
        0.5,
        2,
        "percent",
      ),
      metric(
        "unrelated-errors",
        "Unrelated flow errors",
        c.unrelatedErrors,
        "%",
        0.5,
        2,
        "percent",
      ),
      metric("checkout-p99", "Checkout p99", c.checkoutP99, "ms", 800, PROVIDER_TIMEOUT_MS, "ms"),
      metric(
        "provider-load",
        "Provider load",
        c.providerLoad,
        " rps",
        4_000,
        PROVIDER_CAPACITY,
        "rps",
      ),
      metric(
        "fallback-covered",
        "Fallback-covered attempts",
        c.fallbackServed,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      providerFail: c.providerFail,
      fallback: c.fallback,
      retries: c.retries,
    },
    summary: `${c.checkoutErrors.toFixed(1)}% payment errors; ${c.unrelatedErrors.toFixed(1)}% unrelated errors; provider load ${Math.round(c.providerLoad).toLocaleString("en-US")} rps.`,
  };
}

function seedSeries(frame: SimFrame, seedValue: number): void {
  const phase = seedValue % 11;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.95 + 0.07 * Math.sin((index + phase) / 3.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "checkout-errors",
    metricId: "checkout-errors",
    warn: 0.5,
    crit: 2,
    title: "The payment flow has no explicit failure semantic",
    cause:
      "Failed provider calls are reaching the checkout response as generic errors. There is no fallback, no deferred capture, and no message that tells the customer what happened.",
    fix: "Choose the failure semantic before the incident: defer capture, use an alternate provider, or return a clear retry-later response. Do not return a generic 500 for a dependency that only affects payment.",
    checkFirst: [
      "Check whether checkout errors are provider errors or local validation errors.",
      "Check whether the fallback path is running and whether it has its own errors.",
      "Check the customer-visible response for a retry or deferral message.",
    ],
  },
  {
    id: "unrelated-errors",
    metricId: "unrelated-errors",
    warn: 0.5,
    crit: 2,
    title: "A provider failure is taking down unrelated flows",
    cause:
      "Provider calls share a connection pool, thread pool, or concurrency budget with flows that do not need the provider. Slow calls hold those resources until unrelated requests time out.",
    fix: "Isolate provider calls behind a bulkhead with their own pool, concurrency limit, and timeout. Unrelated flows should keep their own capacity even when the provider is unavailable.",
    checkFirst: [
      "Compare errors in flows that call the provider with flows that do not.",
      "Check pool saturation and wait time on the shared resource.",
      "Check whether the provider timeout is longer than the request deadline.",
    ],
  },
  {
    id: "checkout-p99",
    metricId: "checkout-p99",
    warn: 800,
    crit: PROVIDER_TIMEOUT_MS,
    title: "Checkout is waiting for a provider that cannot answer in time",
    cause:
      "The provider latency exceeds the checkout deadline. Waiting longer does not produce a successful payment; it only holds the request and its resources for longer.",
    fix: "Bound the provider call with a timeout shorter than the checkout deadline and route the failure to the fallback. A longer timeout moves the failure later without improving the outcome.",
    checkFirst: [
      "Compare provider latency with the checkout deadline.",
      "Check whether the timeout is enforced on the connection as well as the request.",
      "Check whether retries are adding to the wait.",
    ],
  },
  {
    id: "provider-load",
    metricId: "provider-load",
    warn: 4_000,
    crit: PROVIDER_CAPACITY,
    title: "Retries are adding load to a failing provider",
    cause:
      "Each failed payment can be retried, and every retry arrives at the same provider. The provider is already failing; the additional load makes its recovery slower and increases the chance that it sheds more traffic.",
    fix: "Stop retrying during the outage, cap retries with a budget for normal operation, and use a breaker to fail fast. Retrying a third party is not a containment strategy.",
    checkFirst: [
      "Check the retry rate against the original payment rate.",
      "Check whether the provider is shedding or timing out because of retry load.",
      "Check whether the retry budget and breaker are configured and active.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-provider-containment",
  title: "Predict what contains a provider outage",
  simId: "dependency-failure",
  question:
    "The payment provider is returning errors and checkout returns 500 for every cart. Your browse and account flows are also failing. What contains the outage fastest?",
  prediction: {
    options: [
      { id: "retry", label: "Retry every failed payment more aggressively" },
      { id: "timeout", label: "Raise the provider timeout so more calls can finish" },
      {
        id: "contain",
        label:
          "Isolate provider calls, stop retries, and use a fallback with explicit failure semantics",
      },
      { id: "all", label: "Return 500 for every flow until the provider recovers" },
    ],
    correctOptionId: "contain",
    explanation:
      "Isolation keeps the provider failure out of unrelated flows. A fallback turns a dependency error into a defined outcome for the payment flow. Stopping retries removes the extra load that keeps the provider down. None of these fixes the provider; they contain its failure.",
  },
  setup: defaults({
    providerErrorRatePct: 100,
    providerLatencyMs: 5_000,
    isolationPct: 0,
    fallbackPct: 0,
    retryAttempts: 2,
  }),
  runFor: 30,
  observe: [
    "Checkout payment errors fall from 100% to zero through the fallback path.",
    "Unrelated flow errors fall from 25% to zero with full isolation.",
    "Provider load falls from 7.5k rps to 2.5k rps when retries stop.",
    "Checkout p99 falls from about 1.45s to about 300ms on the fallback path.",
  ],
  explain:
    "The provider was still failing after the mitigation. What changed was the blast radius: unrelated flows stopped sharing the provider's exhausted resources, payment attempts received a defined outcome, and retries stopped adding load. The service recovered before the dependency did, which is the point of containment.",
  fix: defaults({
    providerErrorRatePct: 100,
    providerLatencyMs: 5_000,
    isolationPct: 100,
    fallbackPct: 100,
    retryAttempts: 0,
  }),
  debrief:
    "A third-party outage is not a reason to take down the product. The provider is one dependency, and only the flows that need it should degrade. The team needs a written failure semantic for payment, a tested fallback, and a bulkhead that keeps provider calls away from unrelated work. Retries are a normal-operation tool, not an incident response.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A dependency failure is an outage in a service you do not control. The provider may return errors, time out, or answer slowly while holding your connections. The failure becomes your incident when it escapes the calls that need the dependency and reaches unrelated flows, or when your service turns it into a generic error with no defined customer outcome.",
  },
  {
    type: "p",
    text: "Containment has three parts. Isolation gives the dependency its own connection pool, concurrency limit, and timeout so it cannot consume resources reserved for other work. A fallback defines what happens when the call fails: deferred capture, an alternate provider, a cached result, or a clear retry-later response. Failure semantics make that choice explicit, so checkout does not return the same 500 for a validation error and a provider outage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The boundary is the client library or the edge of the integration, not the provider. Every call to the third party should leave through a bounded path with a timeout, a retry budget, and a breaker. The flows that do not need the provider should be outside that path. If browse and checkout share a thread pool, a slow payment provider can exhaust the pool and fail browse, which is the cascading failure this module is about.",
  },
  {
    type: "table",
    headers: ["Response to a failed payment", "Customer outcome", "Containment quality", "Risk"],
    rows: [
      [
        "Generic 500",
        "No idea whether the payment happened",
        "None",
        "Retries and duplicate charges",
      ],
      [
        "Fail fast with retry later",
        "Clear, recoverable message",
        "Good if the payment is not captured",
        "Customer may abandon the cart",
      ],
      [
        "Deferred capture",
        "Order accepted, payment completed later",
        "Good",
        "Inventory and fraud checks must tolerate the delay",
      ],
      [
        "Alternate provider",
        "Payment may still succeed",
        "Good",
        "Extra integration and reconciliation cost",
      ],
      [
        "Retry aggressively",
        "Longer wait, more load on the provider",
        "Poor",
        "Keeps the provider down and multiplies failures",
      ],
    ],
  },
  {
    type: "p",
    text: "This module models 10k rps, of which 2.5k rps are payment attempts against an illustrative 5k rps provider. The numbers are teaching values. The structure is the lesson: the provider's capacity is finite, your retries consume it, and isolation decides whether the failure stays on the payment path.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Checkout payment errors: the customer-visible result on the affected flow.",
      "Unrelated flow errors: the blast radius beyond the dependency.",
      "Provider load: how much traffic the provider receives, including retries.",
      "Checkout p99: whether the service waits for a provider that cannot answer in time.",
      "Fallback-covered attempts: the defined path that replaces a generic error.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Provider outage. Watch checkout errors and unrelated errors rise together, and check provider load with two retries. Run the experiment before revealing the answer. Then apply Contained, provider still down, and compare the same provider failure with full isolation and fallback. Finish with Provider recovered to see the normal path restored.",
  },
  { type: "sim", simId: "dependency-failure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The provider failed and checkout retried each failed payment twice. Provider load rose from 2.5k rps to 7.5k rps against an illustrative 5k rps capacity. Checkout returned errors for every payment, and because provider calls shared resources with the rest of the service, 25% of unrelated requests failed too. The dependency outage had become a product outage.",
  },
  {
    type: "p",
    text: "With full isolation, a complete fallback, and no retries, the provider was still failing at 100%, but checkout errors and unrelated errors fell to zero. Provider load returned to 2.5k rps. Checkout p99 fell to about 300ms because the fallback path is fast and does not wait for the provider. The service recovered before the dependency did.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Provider error rate and latency from the client side, not only from the provider's status page.",
      "Error rates split by flow: payment, browse, search, account, and support.",
      "Connection pool saturation, in-flight requests, and wait time on the shared resource.",
      "Retry volume and provider load, compared with the original request rate.",
      "Fallback hit rate, fallback error rate, and the customer-visible response code or message.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the failing flows actually need the provider. If unrelated flows are failing, the problem is shared resources, not the provider alone. Check pool saturation and timeouts before adding capacity. Then check whether payment has a defined fallback and whether it is serving. Finally, check retry volume: extra load on a failing provider is the fastest way to lengthen the outage.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Put provider calls in a dedicated pool with a concurrency limit and a timeout shorter than the checkout deadline.",
      "Stop retries during the outage and keep a retry budget for normal operation.",
      "Choose an explicit failure semantic for payment: defer capture, alternate provider, or retry later.",
      "Implement and test the fallback, including its own failure mode and alert.",
      "Return a specific response that tells the customer whether the payment was captured.",
      "Reconcile deferred or alternate payments before restoring the normal path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Isolation reserves capacity that may sit idle when the provider is healthy.",
      "A deferred capture improves availability but adds reconciliation work and a window where inventory and payment disagree.",
      "An alternate provider adds integration cost and a second set of failure modes.",
      "A generic failure is sometimes the honest answer if no safe fallback exists; the mistake is not knowing which case you are in.",
      "Stopping retries reduces load but increases the number of customers who see a failure. That is usually the right trade during an outage.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "contain-provider",
    question:
      "A payment provider is failing and your service returns 500 for all requests. What do you do first?",
    difficulty: 3,
    hints: [
      "Separate the flows that need the provider from the ones that do not.",
      "A generic 500 is a failure semantic, and usually the wrong one.",
    ],
    answer:
      "I would first check whether unrelated flows are failing. If they are, the provider is consuming shared resources, so I isolate its calls into a dedicated pool with a concurrency limit and a timeout. I would stop retries to reduce load, then route failed payments to a defined fallback such as deferred capture or a retry-later response. I would verify that browse, search, and account flows recover while payment degrades explicitly. The provider outage is not fixed, but its blast radius is contained.",
    followUps: [
      "What would you show the customer when payment is deferred?",
      "How do you reconcile deferred payments?",
      "What if the fallback provider is also failing?",
    ],
    redFlags: [
      "Retries the provider harder.",
      "Returns a generic 500 for every flow.",
      "Waits for the provider to recover before acting.",
    ],
    rubric: [
      "Separates affected and unaffected flows.",
      "Isolates provider resources.",
      "Defines the payment failure semantic.",
      "Stops retry amplification.",
    ],
  },
  {
    id: "unrelated-failure",
    question: "Only payment calls the provider, but browse is failing too. How can that happen?",
    difficulty: 3,
    hints: [
      "Look at the shared resource, not the dependency graph.",
      "Slow calls hold connections and threads.",
    ],
    answer:
      "The provider calls are probably sharing a connection pool, thread pool, or concurrency budget with browse. Slow or failing calls hold those resources until they time out, so browse waits behind work it does not need. I would check pool saturation, in-flight requests, and wait time, then isolate provider calls into their own bounded pool. The dependency graph says browse does not call the provider; the resource graph says it does.",
    followUps: [
      "Which metric would confirm the shared-pool theory?",
      "How would you size the isolated pool?",
      "What happens to the isolated pool when the provider is healthy?",
    ],
    redFlags: [
      "Assumes the dependency graph is the whole story.",
      "Adds capacity without finding the shared resource.",
      "Raises timeouts to reduce errors.",
    ],
    rubric: [
      "Identifies shared resources.",
      "Names pool saturation and wait time.",
      "Proposes a bulkhead.",
      "Explains the dependency versus resource graph.",
    ],
  },
  {
    id: "retry-policy",
    question: "The provider is failing intermittently. How do you decide whether to retry?",
    difficulty: 3,
    hints: [
      "Retries are for transient failures, not outages.",
      "The provider's capacity matters as much as the error rate.",
    ],
    answer:
      "I would retry only failures that are likely to succeed on a second attempt, such as a connection reset before the request was processed. I would use a bounded retry budget, exponential backoff with jitter, and an idempotency key so a retry cannot duplicate a payment. If the provider is overloaded or returning 5xx for most requests, retries add load and delay recovery; a breaker should fail fast instead. During an incident, I would stop retries entirely until the provider is stable.",
    followUps: [
      "How does an idempotency key change the retry decision?",
      "What is a safe retry budget for payments?",
      "How do you distinguish a transient failure from an outage?",
    ],
    redFlags: ["Retries every error the same way.", "No idempotency key.", "No budget or breaker."],
    rubric: [
      "Retries only transient failures.",
      "Uses a budget and backoff.",
      "Protects against duplicate payments.",
      "Stops retries during an outage.",
    ],
  },
  {
    id: "recovery-order",
    question: "The provider is healthy again. In what order do you restore your service?",
    difficulty: 3,
    hints: [
      "Your service may have a backlog and open breakers.",
      "Reconcile before you resume normal traffic.",
    ],
    answer:
      "I would first verify the provider from our side with a small probe, not just its status page. Then I would reconcile deferred or alternate payments, close the breaker gradually, and restore the normal path in stages while watching error rate, latency, and retry volume. I would keep the fallback available until the provider has stayed healthy through a full traffic cycle. The provider being healthy is necessary but not sufficient; our backlog, connection pools, and customers still need to recover.",
    followUps: [
      "How do you close a breaker safely?",
      "What backlog would you expect after deferred capture?",
      "How do you avoid a reconnect storm?",
    ],
    redFlags: [
      "Restores all traffic at once.",
      "Trusts the status page only.",
      "Ignores deferred payments.",
    ],
    rubric: [
      "Probes the provider from the client side.",
      "Reconciles before restoring.",
      "Ramps traffic in stages.",
      "Keeps the fallback until stable.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every third-party call has a timeout shorter than the caller's deadline.",
      "Provider calls use a dedicated connection pool and concurrency limit.",
      "Each affected flow has a written failure semantic and a tested fallback.",
      "Retries use a budget, backoff, jitter, and an idempotency key.",
      "Error rates are split by flow so unrelated impact is visible.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether failing flows actually need the provider.",
      "Isolate provider resources before adding capacity.",
      "Stop retries and fail fast while the provider is down.",
      "Route failed payments to the defined fallback and verify its health.",
      "Tell customers whether the payment was captured, deferred, or refused.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile deferred, alternate, and duplicate payment attempts.",
      "Restore the normal path in stages and watch retry volume.",
      "Review whether the fallback failed or produced a confusing outcome.",
      "Check that unrelated flows have their own capacity and alerts.",
      "Add the provider outage and the containment decision to the postmortem.",
    ],
  },
];

const references = [
  {
    title: "Reliability Pillar - AWS Well-Architected Framework",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Bulkheads, dependency isolation, and degradation patterns.",
  },
  {
    title: "Addressing cascading failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Failure containment, retry amplification, and load shedding.",
  },
  {
    title: "Avoiding fallback in distributed systems",
    url: "https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "The hidden cost of fallback paths and how to keep them safe.",
  },
];

export const dependencyFailureModel: SimModel = {
  id: "reliability-dependency-failure",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);
    if (
      values.providerFail >= 0.5 &&
      values.checkoutErrors < 0.5 &&
      values.unrelatedErrors < 0.5 &&
      frame.flags.containedEvent !== 1
    ) {
      pushEvent(next, {
        id: "dependency-contained",
        at: frame.t,
        severity: "info",
        title: "Provider failure contained",
        detail: `The provider is still failing, but payment has a fallback and unrelated flows are isolated. Provider load is ${Math.round(values.providerLoad).toLocaleString("en-US")} rps.`,
        nodeId: "fallback",
        metricId: "checkout-errors",
      });
      next.flags.containedEvent = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `At ${Math.round(frame.t)}s, payment is ${Math.round(PAYMENT_SHARE * 100)}% of 10k rps, or ${PAYMENT_RPS.toLocaleString("en-US")} rps. The provider is offered ${Math.round(values.providerLoad).toLocaleString("en-US")} rps, including ${Math.round(values.retryLoad).toLocaleString("en-US")} rps of retries.`,
    );
    items.push(
      `Provider failure is modeled at ${Math.round(values.providerFail * 100)}%. Fallback coverage is ${Math.round(values.fallback * 100)}%, so checkout errors are ${values.checkoutErrors.toFixed(1)}%.`,
    );
    items.push(
      `Bulkhead isolation is ${Math.round(values.isolation * 100)}%, so unrelated flow errors are ${values.unrelatedErrors.toFixed(1)}%. Isolation is about shared resources, not the dependency graph.`,
    );
    items.push(
      "The provider can stay down while your service recovers. That is containment. The service has not fixed the third party; it has removed the third party from flows that do not need it and given the affected flow a defined outcome.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Provider down", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 300ms provider, full fallback, strong isolation, and no retries.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Provider errors",
    description:
      "A 20% provider error rate with one retry. Unrelated flows show minor impact; checkout stays inside its error threshold.",
    tone: "warn",
    params: defaults({
      providerErrorRatePct: 20,
      providerLatencyMs: 900,
      isolationPct: 80,
      fallbackPct: 98,
      retryAttempts: 1,
    }),
  },
  {
    id: "failure",
    label: "Provider outage",
    description:
      "A full provider outage, no isolation, no fallback, and two retries. Every flow fails.",
    tone: "crit",
    params: defaults({
      providerErrorRatePct: 100,
      providerLatencyMs: 5_000,
      isolationPct: 0,
      fallbackPct: 0,
      retryAttempts: 2,
    }),
  },
  {
    id: "contained",
    label: "Contained, provider still down",
    description:
      "The same outage with full isolation, a complete fallback, and no retries. Checkout degrades explicitly.",
    tone: "warn",
    params: defaults({
      providerErrorRatePct: 100,
      providerLatencyMs: 5_000,
      isolationPct: 100,
      fallbackPct: 100,
      retryAttempts: 0,
    }),
  },
  {
    id: "recovery",
    label: "Provider recovered",
    description: "The provider is healthy again and the normal path is restored.",
    tone: "ok",
    params: defaults({
      providerErrorRatePct: 0,
      providerLatencyMs: 300,
      isolationPct: 100,
      fallbackPct: 100,
      retryAttempts: 0,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "dependency-failure": {
      model: dependencyFailureModel,
      presets,
      instructions:
        "Start Healthy, apply Provider outage, and watch checkout and unrelated flows fail together. Run the experiment, then apply Contained and compare the same provider failure with full isolation and fallback. Finish with Provider recovered and note that containment, not the provider, is what restored the service.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Provider capacity, payment share, timeout, and load are teaching values, not a vendor limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-graceful-degradation",
    "reliability-retry-storms",
    "reliability-cache-failure",
    "reliability-load-shedding",
  ],
};
