import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CRITICAL_MS = 180;
const PAGE_BUDGET_MS = 800;
const FALLBACK_MS = 20;

const params = [
  {
    id: "recommendationLatency",
    label: "Recommendation latency",
    min: 50,
    max: 5_000,
    step: 50,
    value: 150,
    unit: " ms",
    group: "Optional dependency",
    help: "Response time of the recommendation service on the product page.",
    format: "ms" as const,
  },
  {
    id: "recommendationTimeout",
    label: "Recommendation timeout",
    min: 50,
    max: 3_000,
    step: 50,
    value: 300,
    unit: " ms",
    group: "Optional dependency",
    help: "Time the page waits for recommendations before its fallback path runs.",
    format: "ms" as const,
  },
  {
    id: "fallbackCoverage",
    label: "Fallback coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Degradation design",
    help: "Share of failed recommendation calls that have a designed fallback. Zero lets the failure reach the page.",
    format: "percent" as const,
  },
  {
    id: "recommendationErrorRate",
    label: "Recommendation error rate",
    min: 0,
    max: 100,
    step: 5,
    value: 1,
    unit: "%",
    group: "Optional dependency",
    help: "Share of recommendation calls that fail outright, separate from slowness.",
    format: "percent" as const,
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
  callMs: number;
  failShare: number;
  coverage: number;
  coveredShare: number;
  uncoveredShare: number;
  pageP99: number;
  pageErrors: number;
  budgetShare: number;
  degradedShare: number;
  fallbackHealth: "ok" | "warn" | "down";
}

function compute(p: Params): Computed {
  const latency = clamp(num(p, "recommendationLatency", 150), 50, 5_000);
  const timeout = clamp(num(p, "recommendationTimeout", 300), 50, 3_000);
  const coverage = clamp(num(p, "fallbackCoverage", 100), 0, 100) / 100;
  const errorShare = clamp(num(p, "recommendationErrorRate", 1), 0, 100) / 100;
  const callMs = Math.min(latency, timeout);
  const timeoutShare = latency > timeout ? 1 : 0;
  const failShare = Math.max(errorShare, timeoutShare);
  const covered = failShare * coverage;
  const uncovered = failShare * (1 - coverage);
  const pageErrors = uncovered * 100;
  const pageP99 =
    uncovered > 0
      ? Math.min(PAGE_BUDGET_MS, CRITICAL_MS + callMs)
      : CRITICAL_MS + callMs + (failShare > 0 ? FALLBACK_MS : 0);
  return {
    callMs,
    failShare,
    coverage: coverage * 100,
    coveredShare: covered * 100,
    uncoveredShare: uncovered * 100,
    pageP99,
    pageErrors,
    budgetShare: (callMs / PAGE_BUDGET_MS) * 100,
    degradedShare: covered * 100,
    fallbackHealth: coverage >= 0.99 ? "ok" : coverage > 0 ? "warn" : "down",
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seed(frame: SimFrame, values: Record<string, number>): void {
  for (const [id, value] of Object.entries(values)) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.96 + 0.06 * Math.sin((index + 4) / 2.8))),
    );
  }
}

function buildFrame(c: Computed, seedValue: number): SimFrame {
  const pageHealth = healthFor(c.pageP99, 500, 1_200);
  const errorHealth = healthFor(c.pageErrors, 0.5, 2);
  const recommendationHealth = c.uncoveredShare > 0 ? "crit" : c.failShare > 0.05 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Shopper",
        kind: "client",
        health: "ok",
        sublabel: "product page",
        meta: { view: "flow" },
      },
      {
        id: "page",
        label: "Product page",
        kind: "service",
        health: pageHealth,
        utilization: clamp(c.budgetShare / 100),
        sublabel: `${Math.round(c.pageP99)}ms p99`,
        detail: `The page budget is ${PAGE_BUDGET_MS}ms. The optional call can consume at most ${Math.round(c.budgetShare)}% of it in this scenario.`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout path",
        kind: "service",
        health: errorHealth,
        utilization: clamp(c.pageErrors / 100),
        sublabel: `${c.pageErrors.toFixed(1)}% 5xx`,
        meta: { view: "flow" },
      },
      {
        id: "recommendation",
        label: "Recommendations",
        kind: "external",
        health: recommendationHealth,
        utilization: clamp(c.callMs / PAGE_BUDGET_MS),
        sublabel: `${Math.round(c.callMs)}ms call`,
        detail: `Failure share ${Math.round(c.failShare * 100)}%; fallback coverage ${Math.round(c.coverage)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "fallback",
        label: "Fallback content",
        kind: "cache",
        health: c.fallbackHealth,
        utilization: clamp(c.coveredShare / 100),
        sublabel: c.coveredShare > 0 ? `${Math.round(c.coveredShare)}% covered` : "not designed",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-page", "client", "page", 0.8, pageHealth),
      edge("page-checkout", "page", "checkout", clamp((100 - c.pageErrors) / 100), errorHealth),
      edge("page-recommendation", "page", "recommendation", clamp(c.callMs / PAGE_BUDGET_MS), recommendationHealth),
      edge("page-fallback", "page", "fallback", clamp(c.coveredShare / 100), c.fallbackHealth),
    ],
    metrics: [
      metric("page-p99", "Product page p99", c.pageP99, "ms", 500, 1_200, "ms"),
      metric("checkout-errors", "Checkout 5xx", c.pageErrors, "%", 0.5, 2, "percent"),
      metric("optional-budget", "Optional call budget", c.budgetShare, "%", 50, 80, "percent"),
      metric("degraded-share", "Degraded page share", c.degradedShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      failShare: c.failShare,
      coverage: c.coveredShare,
      degraded: c.degradedShare,
    },
    summary: `${Math.round(c.pageP99)}ms page p99; ${c.pageErrors.toFixed(1)}% checkout errors; ${Math.round(c.degradedShare)}% degraded pages.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "page-p99",
    metricId: "page-p99",
    warn: 500,
    crit: 1_200,
    title: "The product page is spending its budget on an optional call",
    cause:
      "The recommendation call shares the page deadline. A slow optional dependency can consume the whole budget, leaving no time for the price, inventory, or checkout response.",
    fix:
      "Give optional calls their own short timeout, cap their share of the page budget, and render a fallback when they miss it. The critical path must not wait for optional work.",
    checkFirst: [
      "Compare the optional call's duration with the page budget.",
      "Check whether the call is on the critical path or parallel with a deadline.",
      "Check which module owns the tail: recommendation, inventory, or price.",
    ],
  },
  {
    id: "checkout-errors",
    metricId: "checkout-errors",
    warn: 0.5,
    crit: 2,
    title: "An optional dependency is returning checkout errors",
    cause:
      "A failed recommendation call is propagating as a page failure because there is no fallback or the fallback also fails. The user loses the purchase path because a non-critical module is unavailable.",
    fix:
      "Catch optional failures at the module boundary, render a degraded module, and preserve the critical response. Emit a degraded flag so the failure is observable rather than silent.",
    checkFirst: [
      "Check whether the 5xx originates in the optional module or the page handler.",
      "Check fallback coverage and the fallback's own error rate.",
      "Check whether the page treats a missing module as fatal.",
    ],
  },
  {
    id: "optional-budget",
    metricId: "optional-budget",
    warn: 50,
    crit: 80,
    title: "Optional work consumes most of the request budget",
    cause:
      "The optional call is allowed to run for most of the page deadline. Even when it eventually succeeds, it leaves no headroom for the critical response or for a retry.",
    fix:
      "Cap optional work at a fixed share of the budget, run it in parallel with a deadline, or move it after the critical response. A smaller promise is better than a missed one.",
    checkFirst: [
      "Map the page budget across its dependency calls.",
      "Check whether optional calls run serially.",
      "Check whether a timeout leaves enough time for the critical path.",
    ],
  },
];

export const gracefulDegradationModel: SimModel = {
  id: "foundations-graceful-degradation",
  visual: "flow",
  params,
  init: ({ seed: seedValue }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seedValue);
    seed(frame, {
      "page-p99": values.pageP99,
      "checkout-errors": values.pageErrors,
      "optional-budget": values.budgetShare,
      "degraded-share": values.degradedShare,
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    if (c.uncoveredShare > 0) {
      items.push(
        `${c.uncoveredShare.toFixed(1)}% of page requests fail because the optional call fails without a fallback.`,
      );
    } else if (c.coveredShare > 0) {
      items.push(
        `${Math.round(c.coveredShare)}% of pages render a fallback. The page stays available and the missing module is visible as a degraded response.`,
      );
    } else {
      items.push("The optional call is healthy, so no fallback is exercised.");
    }
    items.push(
      `The optional call uses ${Math.round(c.budgetShare)}% of the ${PAGE_BUDGET_MS}ms page budget. Anything above the cap leaves the critical path without headroom.`,
    );
    items.push(
      "A fallback is a product contract: decide what the page shows, whether the omission is labeled, and which metrics prove the degraded path still works.",
    );
    items.push(
      "The critical path should be able to finish even when every optional module fails. If it cannot, the module is not optional.",
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
    description: "A fast recommendation call with a fallback that is ready but unused.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow recommendations",
    description: "The optional call takes 450ms inside an 800ms page budget.",
    tone: "warn",
    params: defaults({ recommendationLatency: 450, recommendationTimeout: 800 }),
  },
  {
    id: "failure",
    label: "No fallback",
    description: "A 2.4s recommendation call with no fallback blocks checkout and returns 5xx.",
    tone: "crit",
    params: defaults({
      recommendationLatency: 2_400,
      recommendationTimeout: 2_400,
      fallbackCoverage: 0,
      recommendationErrorRate: 80,
    }),
  },
  {
    id: "uncovered",
    label: "Partial fallback",
    description: "The same slow call with only half the failures covered.",
    tone: "crit",
    params: defaults({
      recommendationLatency: 2_400,
      recommendationTimeout: 2_400,
      fallbackCoverage: 50,
      recommendationErrorRate: 80,
    }),
  },
  {
    id: "recovery",
    label: "Degraded but available",
    description: "A 250ms timeout and full fallback keep the page inside its budget.",
    tone: "warn",
    params: defaults({
      recommendationLatency: 2_400,
      recommendationTimeout: 250,
      fallbackCoverage: 100,
      recommendationErrorRate: 80,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-degradation",
  title: "Predict what saves the page",
  simId: "degradation",
  question:
    "Recommendations slow to 2.4s and checkout is returning 5xx. Which change restores the page first?",
  prediction: {
    options: [
      { id: "timeout-fallback", label: "A 250ms timeout plus a fallback for the recommendation module" },
      { id: "raise-timeout", label: "Raise the recommendation timeout so the call can finish" },
      { id: "retry", label: "Retry the recommendation call until it succeeds" },
      { id: "budget", label: "Increase the page budget so the slow call fits" },
    ],
    correctOptionId: "timeout-fallback",
    explanation:
      "The optional module must fail inside its own budget. A short timeout bounds the page's exposure, and the fallback turns the miss into a usable page. Raising the timeout or the page budget moves the failure into the critical path. Retrying a slow dependency adds load and delays the page further.",
  },
  setup: defaults({
    recommendationLatency: 2_400,
    recommendationTimeout: 2_400,
    fallbackCoverage: 0,
    recommendationErrorRate: 80,
  }),
  runFor: 22,
  observe: [
    "Page p99 falls from 800ms to 450ms.",
    "Checkout 5xx falls from 80% to zero.",
    "The degraded page share rises to 100%, which is the intended behavior.",
    "The recommendation dependency stays slow; the product stops paying the full 2.4s on the critical path.",
  ],
  explain:
    "Graceful degradation is a dependency hierarchy expressed in code and in time budgets. The critical path owns the page deadline; optional work gets a smaller allowance and a fallback. The fallback is not a cache of the recommendation service; it is a designed response that the product accepts when the module is unavailable. That design decision must be made before the incident.",
  fix: defaults({
    recommendationLatency: 2_400,
    recommendationTimeout: 250,
    fallbackCoverage: 100,
    recommendationErrorRate: 80,
  }),
  debrief:
    "The page is available and checkout works, but every page is degraded. That is recovery for the critical promise, not for the feature. The next step is to investigate the recommendation dependency, keep the fallback path exercised, and alert on the degraded share so a silent partial outage does not become permanent.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Graceful degradation is the practice of keeping the critical promise when a non-critical dependency fails. The page still shows price, availability, and checkout; the recommendation module is missing, reduced, or replaced by a fallback. The engineering work is a dependency hierarchy: each dependency gets a tier, a time budget, and a defined behavior when it fails. A failure that reaches the user as a server error (5xx) means the hierarchy was not enforced in the request path.",
  },
  {
    type: "p",
    text: "The failure it prevents is collateral damage. If an optional recommendation call shares the page deadline and its exception propagates, a recommendation outage becomes a checkout outage. The user does not care that recommendations are optional; they see a 500 on the purchase path. Degradation makes the optionality real in the request path, not just in the architecture diagram.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The hierarchy lives at the page or API composition layer. That layer knows which modules are required for the product promise and which can be omitted. It gives each optional module its own timeout, runs it in parallel where possible, and catches its failure before it reaches the response. The fallback sits behind that boundary, not inside the recommendation client, because only the composition layer knows what the page can show.",
  },
  {
    type: "table",
    headers: ["Tier", "Examples", "Failure behavior", "Time budget"],
    rows: [
      ["Critical", "Price, inventory, payment, checkout", "Fail the request with a clear error", "Owns the remaining page deadline"],
      ["Important", "Reviews, delivery estimate", "Use a cached or simplified value", "A fixed share, shorter than the page budget"],
      ["Optional", "Recommendations, promotions, personalization", "Render a fallback or omit the module", "Short and independently bounded"],
      ["Background", "Analytics, email, search indexing", "Queue, retry later, or drop", "Outside the request path"],
    ],
  },
  {
    type: "p",
    text: "This module models a product page with a 180ms critical path and an 800ms page budget. The recommendation call is optional, but in the failure preset it is allowed to consume 2.4s and has no fallback. Those values are illustrative. The shape is the lesson: an optional dependency with a critical-path timeout is not optional.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Product page p99: whether the optional call is consuming the critical budget.",
      "Checkout 5xx: the share of requests where an optional failure became a page failure.",
      "Optional call budget: how much of the page deadline the recommendation call is allowed to use.",
      "Degraded page share: pages that rendered with a fallback. This is a feature, not automatically an error.",
      "Recommendation and fallback nodes: the dependency's state and whether a designed fallback exists.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No fallback. Watch page p99 pin to the budget and checkout 5xx rise. Run the experiment before reading its explanation. Then apply Recovery and confirm that the page is fast and checkout is healthy while the degraded share is 100%. That combination is the point: the critical promise is kept, and the missing feature is visible.",
  },
  { type: "sim", simId: "degradation" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The recommendation call was placed on the critical path with a 2.4s timeout and no fallback. When it slowed, every page waited for it, and 80% of requests failed when the call failed. Page p99 hit the 800ms budget and checkout returned 5xx even though price and inventory were healthy. An optional dependency had become a required one through timeout and error propagation.",
  },
  {
    type: "p",
    text: "The 250ms timeout and full fallback changed the dependency's tier in the request path. The page stopped waiting after 250ms, rendered a fallback in 20ms, and finished in about 450ms. Checkout errors fell to zero. The recommendation service was still slow, so 100% of pages were degraded. That is a successful recovery of the critical promise, not a repair of the feature.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Page metrics: p99 split by module, checkout success, and the share of responses served in degraded mode.",
      "Dependency metrics: recommendation latency and error rate, with its own timeout and circuit-breaker state.",
      "Fallback metrics: render rate, fallback error rate, and cache age. A fallback that is never exercised is an untested path.",
      "Traces: the optional span ending at the timeout while the parent span completes successfully with a degraded marker.",
      "Logs and events: a clear degraded flag, not a swallowed exception. Silent degradation hides a persistent failure.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find which module owns the tail of the page latency. Compare its timeout with the page budget and check whether its failure is caught. If the page 5xx and the critical modules are healthy, the optional call is on the critical path. Then check whether a fallback exists, whether it is bounded, and whether the product accepts what it shows.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Rank dependencies by the product promise they support: critical, important, optional, background.",
      "Give each tier a time budget smaller than the remaining page budget; run optional calls in parallel where possible.",
      "Catch optional failures at the composition boundary and render a designed fallback or omit the module.",
      "Mark degraded responses explicitly and emit a metric; do not let a fallback hide a permanent dependency failure.",
      "Exercise the fallback in normal operation and in game days so the code path is not cold during an incident.",
      "Verify that the critical path completes when every optional dependency fails.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A fallback is a product decision. A page without recommendations may be acceptable; a page without price is not.",
      "Short optional timeouts reduce page latency but increase the degraded share when the dependency is merely slow.",
      "Fallbacks can be stale or less personalized, so they need their own freshness and labeling rules.",
      "Keeping the fallback path warm costs engineering time and occasional user-visible degradation during tests.",
      "Degradation hides the feature failure from users, which is good for availability and bad for detection; the degraded-share metric must be owned.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rank-dependencies",
    question:
      "How do you decide which dependencies are critical and which can degrade?",
    difficulty: 2,
    hints: [
      "Start from the product promise, not the architecture diagram.",
      "Ask what the user can still complete.",
    ],
    answer:
      "I rank by what the user must be able to do. Price, inventory, payment, and checkout are critical because the purchase cannot complete without them. Recommendations, reviews, and personalization are optional because the same purchase can complete with a fallback or no module. Delivery estimates may be important but can use a cached value. The ranking is a product decision, so I would write it down with the fallback behavior and get the product owner to agree. Then I enforce the tier in the request path with separate timeouts and failure handling.",
    followUps: [
      "What if a dependency is critical for one flow and optional for another?",
      "Who owns the fallback content?",
      "How do you test the ranking after a dependency changes?",
    ],
    redFlags: [
      "Ranks by call volume or visibility.",
      "Treats every dependency as critical.",
      "Has no fallback owner.",
    ],
    rubric: [
      "Starts from the user promise.",
      "Assigns explicit tiers.",
      "Names fallback behavior.",
      "Involves the product owner.",
    ],
  },
  {
    id: "timeout-isolation",
    question:
      "The recommendation call has a 300ms timeout but the page still times out at 800ms. What is wrong?",
    difficulty: 3,
    hints: [
      "A timeout is not the same as a budget.",
      "Look at what runs before and after the call.",
    ],
    answer:
      "The timeout bounds the recommendation call, but the page may be spending its budget elsewhere: serial critical calls, retries, queueing, or a fallback that also waits. I would map the budget across the whole request, including queue wait, and check whether the optional call runs in parallel or after the critical work. I would also check whether the timeout applies to the connection, the first byte, or the full body. The fix is to give the page an absolute deadline, give each optional call a smaller allowance inside it, and verify that the critical path can finish with time to spare.",
    followUps: [
      "How would you measure queue wait separately from service time?",
      "What happens if the fallback is slower than the timeout?",
      "Would you cancel the optional call when the page deadline nears?",
    ],
    redFlags: [
      "Assumes the timeout is the whole budget.",
      "Ignores serial calls and queue wait.",
      "Adds a retry to an already slow optional call.",
    ],
    rubric: [
      "Maps the full request budget.",
      "Distinguishes timeout from deadline.",
      "Checks serial versus parallel work.",
      "Bounds the fallback.",
    ],
  },
  {
    id: "degraded-observability",
    question:
      "Your service returns 200 with a fallback module. How do you make sure the degradation is visible to operators?",
    difficulty: 2,
    hints: [
      "HTTP status is not enough.",
      "The fallback path needs its own signals.",
    ],
    answer:
      "I would emit a structured degraded flag and a metric per module: fallback render rate, fallback error rate, and the reason. I would trace the optional span with its timeout and outcome, and log the first transition into degraded mode, not every request. The dashboard should show checkout success alongside the degraded share, so a 200 with a missing module is not mistaken for a fully healthy page. I would also alert on a sustained degraded share, because a fallback that runs forever is a hidden outage.",
    followUps: [
      "What would you alert on first?",
      "How do you avoid log spam from a permanent fallback?",
      "Should the degraded response be cached?",
    ],
    redFlags: [
      "Relies on 200 as proof of health.",
      "Logs every degraded request.",
      "Has no owner for the degraded metric.",
    ],
    rubric: [
      "Adds a degraded flag and metric.",
      "Separates first transition from steady state.",
      "Pairs availability with degraded share.",
      "Alerts on sustained degradation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every dependency has a tier and a documented behavior when it fails.",
      "Optional calls have their own timeout inside the page budget.",
      "A fallback exists for each optional module and has a product owner.",
      "The fallback path is exercised in normal operation and in game days.",
      "Degraded responses emit a metric and a structured flag.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the module that owns the page tail before changing capacity.",
      "Check whether the optional call is serial and on the critical path.",
      "Disable or time out the optional module before raising the page budget.",
      "Verify checkout success, not only page latency.",
      "Record the degraded share and the user-visible behavior.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the critical path still works with every optional dependency down.",
      "Review whether the fallback content is still acceptable to the product.",
      "Fix the dependency or keep the fallback, but assign an owner to the degraded metric.",
      "Add a test that fails an optional dependency and asserts a 200 with a degraded flag.",
    ],
  },
];

const references = [
  {
    title: "Addressing cascading failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Serving degraded results, deadline propagation, and dependency failure containment.",
  },
  {
    title: "Reliability pillar: AWS Well-Architected Framework",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Failure isolation, graceful degradation, and recovery design guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    degradation: {
      model: gracefulDegradationModel,
      presets,
      instructions:
        "Start healthy, apply No fallback, then compare Recovery. Watch page p99 and checkout 5xx together, and read the degraded share as a product outcome rather than an error.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 800ms page budget, 180ms critical path, and fallback cost are teaching values, not a product guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-bulkheads",
    "foundations-timeouts",
    "reliability-graceful-degradation",
    "reliability-dependency-failure",
  ],
};
