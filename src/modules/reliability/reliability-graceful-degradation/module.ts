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

const CRITICAL_PATH_MS = 180;
const OPTIONAL_TIMEOUT_MS = 500;
const PAGE_BUDGET_MS = 1_200;
const OPTIONAL_MODULES = 4;
const PER_MODULE_MS = 30;

const params: ParamSpec[] = [
  {
    id: "optionalLatencyMs",
    label: "Optional dependency latency",
    min: 100,
    max: 8_000,
    step: 100,
    value: 180,
    unit: " ms",
    group: "Dependency",
    help: "Response time of the recommendation dependency on the product page.",
    format: "ms",
  },
  {
    id: "timeToActSec",
    label: "Time to degradation decision",
    min: 0,
    max: 300,
    step: 5,
    value: 10,
    unit: " s",
    group: "Incident response",
    help: "Simulated time before the team disables optional modules. Long delays let the dependency affect checkout.",
    format: "number",
  },
  {
    id: "modulesDisabled",
    label: "Optional modules disabled",
    min: 0,
    max: OPTIONAL_MODULES,
    step: 1,
    value: 0,
    unit: "",
    group: "Incident response",
    help: "Modules turned off when the decision lands. Disabling all four removes the optional call from the page.",
    format: "count",
  },
  {
    id: "fallbackCoveragePct",
    label: "Fallback coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Fallback",
    help: "Share of slow optional calls served by a designed fallback instead of failing the page.",
    format: "percent",
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
  latency: number;
  timeToAct: number;
  disabled: number;
  active: boolean;
  effectiveDisabled: number;
  callMs: number;
  timedOut: boolean;
  fallback: number;
  uncovered: number;
  pageP99: number;
  checkoutErrors: number;
  degradedShare: number;
  undecidedSec: number;
}

function compute(p: Params, t: number): Computed {
  const latency = Math.max(100, num(p, "optionalLatencyMs", 180));
  const timeToAct = clamp(num(p, "timeToActSec", 10), 0, 300);
  const disabled = clamp(Math.round(num(p, "modulesDisabled", 0)), 0, OPTIONAL_MODULES);
  const fallback = clamp(num(p, "fallbackCoveragePct", 100), 0, 100) / 100;
  const active = t >= timeToAct;
  const effectiveDisabled = active ? disabled : 0;
  const callMs =
    effectiveDisabled >= OPTIONAL_MODULES
      ? 0
      : latency + (OPTIONAL_MODULES - effectiveDisabled) * PER_MODULE_MS;
  const timedOut = callMs > OPTIONAL_TIMEOUT_MS;
  const uncovered = timedOut ? 1 - fallback : 0;
  const pageP99 =
    CRITICAL_PATH_MS + Math.min(callMs, OPTIONAL_TIMEOUT_MS) + (uncovered > 0 ? 60 : 0);
  return {
    latency,
    timeToAct,
    disabled,
    active,
    effectiveDisabled,
    callMs,
    timedOut,
    fallback,
    uncovered,
    pageP99,
    checkoutErrors: uncovered * 6,
    degradedShare: active ? (disabled / OPTIONAL_MODULES) * 100 : 0,
    undecidedSec: active ? 0 : t,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seedValue: number, t: number): SimFrame {
  const pageHealth = healthFor(c.pageP99, 500, PAGE_BUDGET_MS);
  const checkoutHealth = healthFor(c.checkoutErrors, 0.5, 2);
  const dependencyHealth = c.timedOut ? (c.uncovered > 0 ? "crit" : "warn") : "ok";
  const fallbackHealth = c.timedOut
    ? c.fallback >= 1
      ? "ok"
      : c.fallback > 0
        ? "warn"
        : "down"
    : "ok";
  const moduleHealth: "ok" | "warn" | "crit" | "down" =
    c.effectiveDisabled >= OPTIONAL_MODULES ? "down" : c.effectiveDisabled > 0 ? "warn" : "ok";
  return {
    t,
    nodes: [
      {
        id: "shopper",
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
        utilization: clamp(c.pageP99 / PAGE_BUDGET_MS),
        sublabel: `${Math.round(c.pageP99)}ms p99`,
        detail: `The critical path costs ${CRITICAL_PATH_MS}ms. The optional call is capped at ${OPTIONAL_TIMEOUT_MS}ms before the fallback runs.`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout path",
        kind: "service",
        health: checkoutHealth,
        utilization: clamp(c.checkoutErrors / 10),
        sublabel: `${c.checkoutErrors.toFixed(1)}% 5xx`,
        detail:
          "Checkout shares the page's time budget. When the page runs late, payment attempts fail even though the payment provider is healthy.",
        meta: { view: "flow" },
      },
      {
        id: "recommendation",
        label: "Recommendations",
        kind: "external",
        health: dependencyHealth,
        utilization: clamp(c.callMs / 8_000),
        sublabel: c.timedOut
          ? `${Math.round(c.latency)}ms, timed out`
          : `${Math.round(c.callMs)}ms call`,
        detail: `Fallback covers ${Math.round(c.fallback * 100)}% of slow calls. Disabled modules: ${c.effectiveDisabled} of ${OPTIONAL_MODULES}.`,
        meta: { view: "flow" },
      },
      {
        id: "fallback",
        label: "Fallback content",
        kind: "cache",
        health: fallbackHealth,
        utilization: clamp(c.fallback),
        sublabel:
          c.fallback >= 1 ? "full coverage" : c.fallback > 0 ? "partial coverage" : "not designed",
        meta: { view: "flow" },
      },
      {
        id: "modules",
        label: "Optional feature set",
        kind: "service",
        health: moduleHealth,
        utilization: clamp(c.effectiveDisabled / OPTIONAL_MODULES),
        sublabel: `${OPTIONAL_MODULES - c.effectiveDisabled} of ${OPTIONAL_MODULES} enabled`,
        detail:
          "The feature set is the tradeoff. A degradation that removes every optional module protects checkout but changes the product.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("shopper-page", "shopper", "page", 0.9, pageHealth),
      edge("page-checkout", "page", "checkout", clamp(1 - c.checkoutErrors / 10), checkoutHealth),
      edge(
        "page-recommendation",
        "page",
        "recommendation",
        clamp(c.callMs / 8_000),
        dependencyHealth,
      ),
      edge("page-fallback", "page", "fallback", clamp(c.fallback), fallbackHealth),
      edge(
        "page-modules",
        "page",
        "modules",
        clamp(1 - c.effectiveDisabled / OPTIONAL_MODULES),
        moduleHealth,
      ),
    ],
    metrics: [
      metric("checkout-errors", "Checkout 5xx", c.checkoutErrors, "%", 0.5, 2, "percent"),
      metric("page-p99", "Product page p99", c.pageP99, "ms", 500, PAGE_BUDGET_MS, "ms"),
      metric("undecided", "Time without a decision", c.undecidedSec, "s", 10, 30, "number"),
      metric(
        "degraded-share",
        "Optional modules disabled",
        c.degradedShare,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("optional-call", "Optional call duration", c.callMs, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      disabled: c.effectiveDisabled,
      active: c.active ? 1 : 0,
      degraded: c.degradedShare,
    },
    summary: `${c.checkoutErrors.toFixed(1)}% checkout errors; page p99 ${Math.round(c.pageP99)}ms; ${c.effectiveDisabled} optional modules disabled.`,
  };
}

function seedSeries(frame: SimFrame, seedValue: number): void {
  const phase = seedValue % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.95 + 0.07 * Math.sin((index + phase) / 2.9))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "checkout-errors",
    metricId: "checkout-errors",
    warn: 0.5,
    crit: 2,
    title: "An optional dependency is failing checkout",
    cause:
      "The optional call is consuming the page's time budget. Checkout shares that budget, so a slow recommendation dependency turns into payment failures even though the payment provider is healthy.",
    fix: "Disable the optional module from the pre-ranked list, or serve its designed fallback. Do not increase the checkout timeout to hide the dependency latency.",
    checkFirst: [
      "Compare checkout errors with optional-dependency latency.",
      "Check whether the fallback path is running or failing open.",
      "Check which features were disabled and which are still on the page.",
    ],
  },
  {
    id: "page-p99",
    metricId: "page-p99",
    warn: 500,
    crit: PAGE_BUDGET_MS,
    title: "The page is spending its budget on optional work",
    cause:
      "The page waits for an optional dependency before it can render the critical path. The budget is shared, so optional latency becomes critical latency.",
    fix: "Move the optional call off the critical path, cap its timeout, and serve a fallback. If the dependency is already slow, disable the module rather than tuning it during the incident.",
    checkFirst: [
      "Check whether the slow span is on the critical path or behind a timeout.",
      "Check the page budget and the optional call's share of it.",
      "Check whether disabling one module is enough or the whole optional set must go.",
    ],
  },
  {
    id: "undecided",
    metricId: "undecided",
    warn: 10,
    crit: 30,
    title: "The team has not made a degradation decision",
    cause:
      "The incident is active and no feature has been disabled. Waiting for a diagnosis or a latency fix keeps the critical path exposed to a dependency the team could have removed immediately.",
    fix: "Use the pre-ranked list to disable the slow optional module, record the decision, and communicate the feature loss. Tune the dependency after the critical path is protected.",
    checkFirst: [
      "Check whether a degradation runbook exists and who can approve it.",
      "Check whether the slow module is on the pre-ranked list.",
      "Check whether the team is waiting on a fix that is not on the critical path.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-degradation-order",
  title: "Predict the fastest way to protect checkout",
  simId: "degradation-incident",
  question:
    "Recommendation latency is 4s and checkout is failing. The team can spend the next ten minutes tuning the recommendation service or disabling the four optional modules now. Which action restores checkout sooner?",
  prediction: {
    options: [
      { id: "tune", label: "Tune the recommendation service first, then reassess checkout" },
      {
        id: "disable",
        label: "Disable the optional modules now, accept the feature loss, and restore checkout",
      },
      { id: "timeout", label: "Raise the checkout timeout so slow pages can finish" },
      { id: "wait", label: "Wait for the recommendation service to recover on its own" },
    ],
    correctOptionId: "disable",
    explanation:
      "The dependency is optional. Removing it restores the critical path immediately and reversibly. Tuning may be the right follow-up, but it competes with the incident clock. Raising the timeout moves the failure later and increases the time customers wait.",
  },
  setup: defaults({
    optionalLatencyMs: 4_000,
    timeToActSec: 300,
    modulesDisabled: 0,
    fallbackCoveragePct: 0,
  }),
  runFor: 30,
  observe: [
    "Checkout 5xx falls from about 6% to zero once all optional modules are disabled.",
    "Product page p99 falls from about 740ms to the 180ms critical path.",
    "The optional feature set goes from fully enabled to fully disabled.",
    "Time without a decision falls to zero, but the product loses every optional feature.",
  ],
  explain:
    "The page budget was being spent on work that was not required for checkout. Disabling the optional modules did not fix the recommendation dependency; it removed the dependency from the critical path. That is the incident move: restore the promise first, then repair the degraded component. The cost is visible in the feature set, which is why the decision and the customer message belong together.",
  fix: defaults({
    optionalLatencyMs: 4_000,
    timeToActSec: 5,
    modulesDisabled: 4,
    fallbackCoveragePct: 50,
  }),
  debrief:
    "Degradation is a ranking exercise, not a latency exercise. The team needs a pre-ranked list of optional dependencies, a fallback for each, and authority to disable them without a meeting. Disabling everything is sometimes correct, but it should be the last item on the list, not the first instinct. The incident record should show which features were removed, when, and what customers were told.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Graceful degradation is the planned removal of optional work so the critical path can keep its promise. During an incident, the question is not how to make the slow dependency fast. It is which features can be turned off now, with a known customer impact, to restore checkout, login, or payment.",
  },
  {
    type: "p",
    text: "The prerequisite module covers one optional dependency, its timeout, and its fallback. This module covers the incident decision across a set of dependencies. A product page may call recommendations, inventory hints, reviews, and personalization. Each has a different value and a different fallback. The team needs a ranked list before the incident, because ranking features while checkout is failing is slow and political.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Degradation sits between the product surface and its dependencies. The page or API gateway owns the budget, the optional calls, and the fallbacks. A feature flag or a configuration service can remove a module without a deploy, but the flag must be tested and the fallback must be real. A flag that turns off recommendations and leaves an empty box is not a fallback; it is a different failure.",
  },
  {
    type: "compare",
    leftTitle: "Tune during the incident",
    rightTitle: "Disable during the incident",
    rows: [
      {
        label: "Time to effect",
        left: "Minutes to hours, with uncertainty",
        right: "Seconds to minutes, if the flag is tested",
      },
      {
        label: "Customer impact",
        left: "The critical path keeps failing while the team works",
        right: "Known feature loss, stated in the update",
      },
      {
        label: "Reversibility",
        left: "Depends on the change and the deploy",
        right: "Usually a flag flip",
      },
      {
        label: "Best use",
        left: "After the critical path is protected",
        right: "First move when an optional dependency is slow",
      },
    ],
  },
  {
    type: "p",
    text: "This module models four optional modules that add 30ms each to a 180ms critical path, with a 500ms timeout and a 1.2s page budget. The values are illustrative. The shape is the lesson: optional work shares the budget, and a fast removal is a product decision that must be pre-authorized.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Checkout 5xx, which shows whether the critical path is still exposed.",
      "Product page p99, which shows the budget consumed by optional work.",
      "Time without a decision, which makes the cost of waiting visible.",
      "Optional modules disabled, which shows the feature tradeoff rather than hiding it.",
      "The recommendation and fallback nodes, which separate a slow dependency from a missing fallback.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Slow dependency. Watch checkout errors rise while the recommendation node stays available but slow. Run the experiment before revealing the answer. Then apply Disable fast and compare checkout with the feature set. Finish with Partial fallback to see the middle ground: some optional calls are covered, but the page still pays for the rest.",
  },
  { type: "sim", simId: "degradation-incident" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With a 4s recommendation dependency, the page waited up to its 500ms optional timeout and then failed the calls that had no fallback. Checkout errors reached about 6%, not because payment was broken, but because checkout shared the page's time budget. Waiting for a decision kept the critical path exposed for the whole window.",
  },
  {
    type: "p",
    text: "Disabling all four optional modules removed the call and returned the page to its 180ms critical path. Checkout errors fell to zero. The cost was visible: every optional feature was gone, and the customer update had to say so. A partial disable would have kept more features but might not have been enough, because the remaining modules still consumed budget above the timeout.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Checkout and payment error rates compared with optional-dependency latency.",
      "Page p99 split by critical and optional spans, preferably from traces.",
      "Feature-flag state and the time of each change, correlated with the incident timeline.",
      "Fallback hit rate and fallback error rate; a fallback that fails is worse than no fallback.",
      "Customer reports and support contacts about missing recommendations or reviews.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare checkout errors with the optional dependency's latency. If checkout is failing only on pages that call the slow module, the dependency is on the critical path and the fix is removal or a fallback. Check whether the fallback is actually serving content, not just suppressing an error. Then check who can flip the flag and whether the ranked list says which module goes first.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Publish a ranked list of optional dependencies with the customer impact of disabling each one.",
      "Give each module a tested fallback and a flag that works without a deploy.",
      "Pre-authorize the on-call engineer to disable the first item on the list.",
      "Disable the slow module, or the whole optional set if the budget requires it, and verify checkout.",
      "Record the decision, the feature loss, and the time so the customer update and postmortem agree.",
      "Repair the dependency after the critical path is protected, then restore features in stages.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Disabling early protects the critical path but removes features customers may be paying for.",
      "A partial fallback preserves more of the product but can still exceed the budget if several optional calls remain.",
      "Feature flags add a control surface that must be tested; an untested flag can fail at the worst moment.",
      "Restoring features too quickly can recreate the incident, especially if the dependency is still slow.",
      "Every degradation is a product decision. The engineering team can execute it, but it should not invent the ranking alone.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rank-dependencies",
    question: "How do you decide which optional dependencies to disable first during an incident?",
    difficulty: 3,
    hints: [
      "Rank by impact on the critical path, not by how interesting the dependency is.",
      "Consider the fallback and the customer-visible loss.",
    ],
    answer:
      "I would rank by how much of the critical path each dependency can consume and how good its fallback is. The first item is the one that is slow, on the page's critical path, and has a safe fallback or can be removed cleanly. I would also weigh the customer impact: recommendations disappearing is usually cheaper than checkout failing. The ranking should exist before the incident, with a product owner's sign-off, so the on-call engineer can act without a meeting.",
    followUps: [
      "What if the top-ranked module is also the revenue driver?",
      "How do you test that a flag removes the dependency completely?",
      "Who owns the ranking after the incident?",
    ],
    redFlags: [
      "Ranks by team ownership.",
      "Disables everything without a customer message.",
      "Waits for a root cause before degrading.",
    ],
    rubric: [
      "Ranks by critical-path impact.",
      "Considers fallback quality.",
      "Names the customer tradeoff.",
      "Requires pre-authorization.",
    ],
  },
  {
    id: "fallback-fails",
    question:
      "You disable recommendations, but the fallback service is also failing and the page now shows an error box. What went wrong?",
    difficulty: 2,
    hints: [
      "A fallback is part of the critical path once it is used.",
      "Suppressing an error is not the same as serving content.",
    ],
    answer:
      "The fallback was treated as a safety net without being tested or monitored. When the optional call was removed, the page depended on the fallback, and the fallback failed. I would remove the fallback too, render a static or empty state that is known to work, and verify that checkout is unaffected. Then I would add fallback health to the dashboard and test the degradation path in staging or a game day.",
    followUps: [
      "Should a missing fallback block the degradation?",
      "How do you measure fallback quality?",
      "What is the customer message for an empty recommendation area?",
    ],
    redFlags: [
      "Assumes a fallback is safe because it exists.",
      "Leaves the error box on the page.",
      "Does not monitor the fallback.",
    ],
    rubric: [
      "Recognizes the fallback as a dependency.",
      "Removes or replaces the failing fallback.",
      "Verifies the critical path.",
      "Adds monitoring and testing.",
    ],
  },
  {
    id: "tune-or-disable",
    question:
      "An engineer wants to tune the slow dependency instead of disabling it. How do you decide?",
    difficulty: 2,
    hints: ["The incident clock is running.", "Tuning can be the follow-up, not the first move."],
    answer:
      "I would ask whether the tuning is reversible, how long it will take, and whether it addresses the critical path. During an active incident, a flag flip that removes optional work is usually faster and safer than a latency change that needs a deploy. I would disable first, confirm checkout, and then tune the dependency without the incident pressure. If the dependency is on the critical path and cannot be removed, tuning may be the only option, but that is a different situation.",
    followUps: [
      "What evidence would make tuning the right first move?",
      "How do you keep the tuning change from becoming a second incident?",
      "When do you restore the disabled feature?",
    ],
    redFlags: [
      "Tunes first because the dependency is owned by the team.",
      "Deploys during the incident without a rollback plan.",
      "Forgets to restore the feature.",
    ],
    rubric: [
      "Protects the critical path first.",
      "Compares speed and reversibility.",
      "Separates mitigation from repair.",
      "Plans restoration.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Optional dependencies are ranked by critical-path impact and customer value.",
      "Each module has a tested fallback and a flag that works without a deploy.",
      "The on-call engineer is pre-authorized to disable the first item on the list.",
      "Checkout, login, and payment errors are separated from optional-feature errors.",
      "The customer-facing message for each degradation is written in advance.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm that the optional dependency is on the critical path before tuning it.",
      "Disable the highest-ranked slow module, or the whole optional set, and verify checkout.",
      "Record the decision time, the flag change, and the feature loss.",
      "Publish a customer update that names what is unavailable.",
      "Keep the flags reversible and do not restore features until the dependency is stable.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that the critical path returned to baseline and the fallback is healthy.",
      "Check whether the degradation was fast enough and whether the ranking was right.",
      "Restore features in stages with the same saturation checks.",
      "Add the degradation decision to the postmortem timeline.",
      "Fix the optional dependency or move it off the critical path permanently.",
    ],
  },
];

const references = [
  {
    title: "Addressing cascading failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Failure containment, load shedding, and avoiding retry amplification.",
  },
  {
    title: "Avoiding fallback in distributed systems",
    url: "https://aws.amazon.com/builders-library/avoiding-fallback-in-distributed-systems/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Fallback cost, failure modes, and when a simpler degraded response is safer.",
  },
];

export const degradationIncidentModel: SimModel = {
  id: "reliability-graceful-degradation",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(values, seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p, frame.t + 0.1);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);
    if (values.active && values.effectiveDisabled > 0 && frame.flags.degradationApplied !== 1) {
      pushEvent(next, {
        id: "degradation-applied",
        at: frame.t,
        severity: "warn",
        title: "Optional modules disabled",
        detail: `${values.effectiveDisabled} of ${OPTIONAL_MODULES} optional modules are off. Checkout errors are ${values.checkoutErrors.toFixed(1)}%; page p99 is ${Math.round(values.pageP99)}ms.`,
        nodeId: "modules",
        metricId: "degraded-share",
      });
      next.flags.degradationApplied = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `The optional call takes ${Math.round(values.callMs)}ms with ${OPTIONAL_MODULES - values.effectiveDisabled} module(s) enabled. The timeout is ${OPTIONAL_TIMEOUT_MS}ms and the page budget is ${PAGE_BUDGET_MS}ms.`,
    );
    items.push(
      values.timedOut
        ? `The dependency exceeds the timeout, so ${Math.round(values.fallback * 100)}% of slow calls are covered and ${Math.round(values.uncovered * 100)}% reach checkout as errors.`
        : "The dependency is inside the timeout and does not currently consume the fallback path.",
    );
    items.push(
      values.active
        ? `The degradation decision landed at ${values.timeToAct}s. ${values.effectiveDisabled} of ${OPTIONAL_MODULES} modules are disabled.`
        : `No degradation decision has landed yet. The incident has been running for ${Math.round(values.undecidedSec)}s.`,
    );
    items.push(
      "The page budget is shared. An optional call that is slow enough to time out still delays the page unless it is removed or served from a fast fallback.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Feature disabled", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "A 180ms recommendation call, full fallback, and no modules disabled. Checkout is clean.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow dependency",
    description:
      "A 1.2s dependency exceeds the timeout, but an 80% fallback keeps checkout at a warning.",
    tone: "warn",
    params: defaults({
      optionalLatencyMs: 1_200,
      fallbackCoveragePct: 80,
      timeToActSec: 20,
      modulesDisabled: 1,
    }),
  },
  {
    id: "failure",
    label: "No degradation",
    description:
      "A 4s dependency with no fallback and no decision for five minutes. Checkout takes the failure.",
    tone: "crit",
    params: defaults({
      optionalLatencyMs: 4_000,
      timeToActSec: 300,
      modulesDisabled: 0,
      fallbackCoveragePct: 0,
    }),
  },
  {
    id: "partial",
    label: "Partial fallback",
    description:
      "The dependency is slow and only half the calls are covered. Checkout still fails.",
    tone: "crit",
    params: defaults({
      optionalLatencyMs: 3_000,
      timeToActSec: 20,
      modulesDisabled: 2,
      fallbackCoveragePct: 50,
    }),
  },
  {
    id: "recovery",
    label: "Disable fast",
    description:
      "The same slow dependency, but all optional modules are disabled within five seconds.",
    tone: "ok",
    params: defaults({
      optionalLatencyMs: 4_000,
      timeToActSec: 5,
      modulesDisabled: 4,
      fallbackCoveragePct: 50,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "degradation-incident": {
      model: degradationIncidentModel,
      presets,
      instructions:
        "Start Healthy, then apply No degradation and watch checkout errors rise while recommendations stay slow. Run the experiment, then apply Disable fast and compare checkout with the optional feature set. Use Partial fallback to see why a fallback that covers only half the calls still leaves the critical path exposed.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Latency, timeout, budget, and module count are teaching values, not a vendor limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-graceful-degradation",
    "reliability-load-shedding",
    "reliability-dependency-failure",
    "reliability-cache-failure",
  ],
};
