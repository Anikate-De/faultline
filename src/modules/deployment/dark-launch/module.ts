import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "flagDefault",
    label: "Flag default for external users (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Exposure",
    help: "The value external users receive when no targeting rule matches. Zero keeps the feature dark; one exposes it to everyone.",
    format: "count",
  },
  {
    id: "internalTrafficPercent",
    label: "Internal validation traffic",
    min: 0,
    max: 100,
    step: 5,
    value: 5,
    unit: "%",
    group: "Verification",
    help: "Share of production traffic that comes from internal users, test tenants, or synthetic checks allowed to exercise the dark path.",
    format: "percent",
  },
  {
    id: "validationCoverage",
    label: "Dark path coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Verification",
    help: "Share of the dark path's branches, dependencies, and failure cases exercised by internal or synthetic traffic.",
    format: "percent",
  },
  {
    id: "darkPathErrorRate",
    label: "Dark path error rate",
    min: 0,
    max: 10,
    step: 0.1,
    value: 0.2,
    unit: "%",
    group: "Verification",
    help: "Errors returned when the dark path is exercised. This is a readiness signal whether or not external users can reach it.",
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

interface Values {
  flagOn: boolean;
  internalShare: number;
  coverage: number;
  exposure: number;
  darkErrors: number;
  validationGap: number;
}

function compute(p: Params): Values {
  const flagOn = num(p, "flagDefault", 0) >= 0.5;
  const internalShare = clamp(num(p, "internalTrafficPercent", 5) / 100, 0, 1);
  const coverage = clamp(num(p, "validationCoverage", 100) / 100, 0, 1);
  const darkPathErrorRate = clamp(num(p, "darkPathErrorRate", 0.2), 0, 10);
  const exercised = flagOn || internalShare > 0;

  return {
    flagOn,
    internalShare: internalShare * 100,
    coverage: coverage * 100,
    exposure: flagOn ? 100 : 0,
    darkErrors: exercised ? darkPathErrorRate : 0,
    validationGap: 100 - coverage * 100,
  };
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const exposureHealth = highHealth(values.exposure, 1, 20);
  const darkHealth = highHealth(values.darkErrors, 0.5, 2);
  const coverageHealth = highHealth(values.validationGap, 10, 30);

  const stageNodes = [
    {
      id: "users",
      label: "External users",
      kind: "client" as const,
      health: exposureHealth,
      utilization: clamp(values.exposure / 100),
      sublabel: values.flagOn ? "feature visible to everyone" : "feature not exposed",
      detail: values.flagOn
        ? "The flag default evaluates on for users who match no override, so the dark path is now a released feature."
        : "External users evaluate the flag off. The code is deployed, but the path is not reachable through normal use.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "dark",
      label: "Dark path",
      kind: "service" as const,
      health: worst(darkHealth, coverageHealth),
      utilization: clamp(values.internalShare / 100),
      sublabel: `${percent(values.internalShare)} internal · ${percent(values.darkErrors)} errors`,
      detail: `Internal and synthetic traffic exercises ${percent(values.internalShare)} of production traffic. Coverage of the path's branches is ${percent(values.coverage)}, and errors are ${percent(values.darkErrors)}.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "flag",
      label: "Feature flag",
      kind: "service" as const,
      health: exposureHealth,
      utilization: clamp(values.exposure / 100),
      sublabel: values.flagOn ? "default ON · global" : "default OFF · targeted",
      detail: values.flagOn
        ? "The default is on, so every user without an explicit override sees the feature. A single default change removed the dark launch."
        : "The default is off. Internal targeting is the only route that exercises the path.",
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "request", label: "Requests", kind: "client" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "gate",
      label: "Flag evaluation",
      kind: "service" as const,
      health: exposureHealth,
      sublabel: values.flagOn ? "external: on" : "external: off",
      meta: { view: "flow" },
    },
    {
      id: "path",
      label: "New feature path",
      kind: "service" as const,
      health: worst(darkHealth, coverageHealth),
      sublabel: `${percent(values.darkErrors)} errors`,
      meta: { view: "flow" },
    },
    {
      id: "internal",
      label: "Internal checks",
      kind: "worker" as const,
      health: coverageHealth,
      sublabel: `${percent(values.coverage)} covered`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("request-gate", "request", "gate", 1, exposureHealth),
      edge("gate-path", "gate", "path", clamp(values.exposure / 100), exposureHealth),
      edge("internal-path", "internal", "path", clamp(values.internalShare / 100), coverageHealth),
    ],
    metrics: [
      metric("user-exposure", "External user exposure", values.exposure, "%", 1, 20, "percent"),
      metric("dark-errors", "Dark path error rate", values.darkErrors, "%", 0.5, 2, "percent"),
      metric("validation-gap", "Dark path validation gap", values.validationGap, "%", 10, 30, "percent"),
      metric("internal-share", "Internal traffic share", values.internalShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), exposure: values.exposure },
    summary: `${percent(values.exposure)} user exposure · ${percent(values.darkErrors)} dark-path errors · ${percent(values.validationGap)} coverage gap`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 5)) / 2.3);
  for (const [id, value] of [
    ["user-exposure", values.exposure],
    ["dark-errors", values.darkErrors],
    ["validation-gap", values.validationGap],
    ["internal-share", values.internalShare],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "user-exposure",
    metricId: "user-exposure",
    warn: 1,
    crit: 20,
    title: "The dark feature is visible to external users",
    cause: "The flag default is on, a targeting rule is too broad, or the flag is missing and the code path runs by default. The feature is no longer dark even though it was not launched.",
    fix: "Turn the flag off and verify that external requests evaluate to the off branch. Make the default off, add explicit internal targeting, and test flag evaluation in staging with a non-internal identity.",
    checkFirst: [
      "Check the flag default and targeting rules.",
      "Check whether the service fails open when the flag provider is unavailable.",
      "Check external request traces for the new code path.",
    ],
  },
  {
    id: "dark-errors",
    metricId: "dark-errors",
    warn: 0.5,
    crit: 2,
    title: "The dark path is failing its validation",
    cause: "The new path returns errors when internal or synthetic traffic exercises it. Keeping users out hides the defect but does not make the feature ready.",
    fix: "Treat the dark-path error rate as a launch gate. Fix the defect, extend coverage to the failing branch, and do not expose external users until the path meets its error target.",
    checkFirst: [
      "Compare dark-path errors with the production baseline.",
      "Check which branches and dependencies the internal traffic actually exercised.",
      "Check whether errors are new or inherited from a shared dependency.",
    ],
  },
  {
    id: "validation-gap",
    metricId: "validation-gap",
    warn: 10,
    crit: 30,
    title: "Most of the dark path is not exercised",
    cause: "Internal or synthetic traffic reaches only part of the new path. The feature looks healthy because the untested branches never run.",
    fix: "Add synthetic cases or internal targeting for the uncovered branches and failure modes. Measure coverage of the path, not the number of internal requests.",
    checkFirst: [
      "Check which routes and branches the internal traffic reaches.",
      "Check whether internal traffic uses production-like data and permissions.",
      "Check whether the coverage measurement includes error branches.",
    ],
  },
];

export const darkLaunchModel: SimModel = {
  id: "deployment-dark-launch",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (resetSeries) seedSeries(next, values, seed);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      values.flagOn
        ? "The flag default is on. Every external user who matches no override sees the feature, so the launch is no longer dark."
        : "The flag default is off. The feature is deployed but unreachable by external users through normal evaluation.",
    );
    items.push(
      `Internal and synthetic traffic is ${percent(values.internalShare)} of production traffic and covers ${percent(values.coverage)} of the dark path.`,
    );
    items.push(
      `The dark path error rate is ${percent(values.darkErrors)}. A path can be hidden from users and still be failing its readiness gate.`,
    );
    items.push(
      "The launch decision depends on coverage and errors, not on the fact that no user has complained.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Partial coverage", tone: "warn" },
    { label: "Exposed or failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The flag defaults off, internal traffic exercises the path, and coverage is complete.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial coverage",
    description: "The path stays dark, but a quarter of its branches are not exercised.",
    tone: "warn",
    params: defaults({ flagDefault: 0, internalTrafficPercent: 20, validationCoverage: 75, darkPathErrorRate: 0.8 }),
  },
  {
    id: "failure",
    label: "Default on",
    description: "The flag default exposes the feature globally, coverage is low, and the path errors.",
    tone: "crit",
    params: defaults({ flagDefault: 1, internalTrafficPercent: 2, validationCoverage: 40, darkPathErrorRate: 6 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The default is off, internal coverage is high, and the path is clean.",
    tone: "ok",
    params: defaults({ flagDefault: 0, internalTrafficPercent: 80, validationCoverage: 100, darkPathErrorRate: 0.2 }),
  },
];

const experiment: Experiment = {
  id: "predict-dark-launch",
  title: "Predict how to keep a pre-launch feature dark",
  simId: "dark-launch",
  question:
    "A feature must be deployed for three weeks before launch. What keeps it from reaching external users while still exercising the code?",
  prediction: {
    options: [
      { id: "default-off", label: "A flag that defaults off for external users, with internal targeting on" },
      { id: "staging", label: "Deploying it only to staging for three weeks" },
      { id: "hide", label: "Hiding the menu entry in the user interface" },
      { id: "low-share", label: "Sending 1% of users to the new version" },
    ],
    correctOptionId: "default-off",
    explanation:
      "A dark launch needs the code in production, the feature unreachable by external users, and a way to exercise the path. A default-off flag with explicit internal targeting provides all three. Hiding a control is not access control, staging does not exercise production, and a 1% share is an exposure, not a dark launch.",
  },
  setup: defaults({ flagDefault: 1, internalTrafficPercent: 2, validationCoverage: 40, darkPathErrorRate: 6 }),
  runFor: 30,
  observe: [
    "External user exposure is 100%, so the feature is already released.",
    "Dark path errors are 6%, above the readiness gate.",
    "Validation covers only 40% of the path.",
    "Internal traffic is 2% of production, too small to have exercised the feature before exposure.",
  ],
  explain:
    "The code being deployed does not make the feature dark. The flag evaluation does. A default-on flag turns the deployment into a release, and low internal coverage means the team learns about defects from the same users who were supposed to be protected.",
  fix: defaults({ flagDefault: 0, internalTrafficPercent: 60, validationCoverage: 100, darkPathErrorRate: 0.2 }),
  debrief:
    "The fixed launch is dark, covered, and clean. The tradeoff is that internal traffic is not identical to external traffic, so the launch still needs a small exposure ramp with a kill switch. The dark period buys evidence, not certainty.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A dark launch deploys code for a feature that is not yet released. The code is present in production, but a flag, targeting rule, or permission check keeps the feature unreachable for external users. Internal users, test tenants, or synthetic checks exercise the path so the team can find defects before launch.",
  },
  {
    type: "p",
    text: "The important distinction is deployment versus release. Deployment puts the artifact on the fleet. Release makes the behavior reachable. A dark launch uses that gap deliberately: the risky code is already in the environment, its dependencies and permissions are real, and the team can verify it for weeks without exposing customers. The flag default is the control that must fail closed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The flag service evaluates a context such as user, tenant, or environment. A default applies when no rule matches; targeting rules can enable the path for internal identities. The application must handle a flag-provider outage safely, usually by treating the flag as off. Synthetic checks and internal traffic generators provide the exercise. Logs and traces show whether the path ran and what it returned.",
  },
  {
    type: "p",
    text: "The exposure, coverage, and error values in this model are illustrative. The structural rule is that dark means unreachable by external users, not merely unlinked. A menu item hidden with CSS, a route reachable by URL, or a default-on flag does not satisfy it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "External user exposure: the share of users who can reach the feature.",
      "Dark-path error rate: errors produced when internal or synthetic traffic exercises it.",
      "Validation gap: the share of branches and failure modes not exercised.",
      "Internal traffic share: how much traffic is available for verification.",
      "A flag node showing whether the default is on or targeted off.",
    ],
  },
  {
    type: "table",
    headers: ["Control", "Keeps users out?", "Exercises production?", "Failure mode"],
    rows: [
      ["Default-off flag", "Yes, if evaluated", "Yes, with targeting", "Default flipped or provider fails open"],
      ["Hidden UI control", "No", "Yes", "Direct URL or API still reaches it"],
      ["Staging-only deploy", "Yes", "No", "Production behavior untested"],
      ["1% exposure ramp", "No", "Yes", "Users are exposed before launch"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and note that exposure is zero while internal traffic still exercises the path. Apply Default on: exposure and dark-path errors rise together. Apply Partial coverage to see a hidden path that is not ready. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "dark-launch" },
  { type: "experiment", experimentId: "predict-dark-launch" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the flag default was on. External exposure reached 100%, so the feature was released even though the team called it a dark launch. Dark-path errors were 6%, and validation covered only 40% of the path. The users who were supposed to be protected became the test group.",
  },
  {
    type: "p",
    text: "The partial-coverage preset shows the quieter failure: exposure stayed at zero, but a quarter of the path never ran. A dark launch can look successful because nothing is on fire while the untested branches wait for launch day.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Flag evaluation logs showing the default on for external identities.",
      "API or deep-link traffic reaching the new path before the launch date.",
      "Low internal traffic that exercises only the happy path.",
      "A flag provider outage that makes the application choose the wrong branch.",
      "Dark-path errors that are hidden from user-facing SLOs but block readiness.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the flag default and targeting rules first, then check whether the application fails closed when the provider is unavailable. Check external traces for the new path. Check which branches internal traffic actually covered, not how many internal requests ran.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Set the default off and verify external evaluation with a non-internal identity.",
      "Add explicit internal or test-tenant targeting rather than a broad percentage.",
      "Make flag-provider failure evaluate to off.",
      "Increase synthetic coverage of branches, dependencies, and error cases.",
      "Gate the launch on dark-path error rate and coverage, not on elapsed time.",
      "Start the real launch with a small exposure ramp and a tested kill switch.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long dark period finds integration defects but delays value and accumulates flag debt.",
      "Internal traffic is safer than exposure but differs from external traffic in data, permissions, and load.",
      "A default-off flag is safe but can hide a feature that is broken for everyone once enabled.",
      "More synthetic coverage improves confidence but costs maintenance and can drift from real behavior.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "keep-dark",
    question:
      "How would you keep a feature dark for three weeks while still proving it works in production?",
    difficulty: 2,
    hints: [
      "Deployment is not release.",
      "Default off, targeted on.",
      "Exercise the path with internal or synthetic traffic.",
    ],
    answer:
      "I would deploy the code behind a flag whose default is off for external users and enable it only for internal identities or test tenants. I would make the application treat a flag-provider failure as off. I would add synthetic checks and internal traffic that cover the important branches, dependencies, and error cases, and I would gate the launch on dark-path errors and coverage. I would also verify that the route is not reachable by direct URL or API for an external identity.",
    followUps: [
      "What if the flag service is unavailable?",
      "How do you measure coverage of the dark path?",
      "What is the exit criterion for the dark period?",
    ],
    redFlags: ["Uses staging only.", "Hides the UI without access control.", "Exposes a percentage of users."],
    rubric: ["Defaults off.", "Uses internal targeting.", "Fails closed.", "Measures coverage and errors."],
  },
  {
    id: "default-on",
    question:
      "A new flag was created with the default on and the feature reached all users. What controls should have prevented it?",
    difficulty: 3,
    hints: [
      "The default is production configuration.",
      "Review and testing need to cover the off branch.",
      "A kill switch limits the damage.",
    ],
    answer:
      "Flag creation should require a reviewed default of off, and the default should be tested with an external identity before the flag is used in production. The flag service should reject or warn on a new flag with an on default in a production environment. A tested kill switch should let the team turn the feature off without a deploy. After the fact, I would check why the default was set, whether the change was reviewed, and whether exposure was detected by a signal rather than a user report.",
    followUps: [
      "Where should the default be enforced?",
      "How would you detect exposure automatically?",
      "What is the rollback path if the flag cannot be changed?",
    ],
    redFlags: ["Relies on review alone.", "Has no kill switch.", "Cannot detect exposure."],
    rubric: ["Requires safe default.", "Tests external evaluation.", "Provides kill switch.", "Detects exposure."],
  },
  {
    id: "coverage",
    question: "How do you know a dark path is ready to launch?",
    difficulty: 3,
    hints: [
      "Requests are not coverage.",
      "Errors and latency matter.",
      "Launch is still an exposure decision.",
    ],
    answer:
      "I would define the branches, dependencies, permissions, and failure modes that matter, then show that internal or synthetic traffic exercised them at production-like data and scale. I would compare dark-path errors and latency with the baseline and require the path to meet the same target as the released service. I would also verify the off branch and the flag-failure behavior. The launch decision then starts with a small exposure and a kill switch, because dark traffic cannot prove the external user experience.",
    followUps: [
      "Which branches are most likely to be missed?",
      "How do you test permissions without real customer data?",
      "What would make you delay the launch?",
    ],
    redFlags: ["Counts internal requests as coverage.", "Ignores error rate.", "Launches at 100% immediately."],
    rubric: ["Defines coverage.", "Uses production-like data.", "Checks errors and latency.", "Ramps exposure."],
  },
  {
    id: "flag-debt",
    question: "What is the risk of leaving a dark-launch flag in place after launch?",
    difficulty: 2,
    hints: [
      "Flags accumulate branches.",
      "Old flags hide dead code and stale behavior.",
      "Cleanup needs an owner and a date.",
    ],
    answer:
      "A permanent flag leaves two code paths to maintain and test, increases the chance that the wrong default is applied, and makes the code harder to reason about. Over time the dark path can become stale or the flag can be removed without checking its dependencies. I would give every launch flag an owner, a removal date, and a cleanup task, and I would remove the off branch once the feature is fully released and the rollback window has passed.",
    followUps: [
      "When is it safe to remove the flag?",
      "How do you find flags with no owner?",
      "Which flags are legitimately long-lived?",
    ],
    redFlags: ["Leaves flags forever.", "Removes the flag without verifying exposure.", "Has no owner."],
    rubric: ["Names maintenance risk.", "Assigns owner and date.", "Defines safe removal.", "Distinguishes permanent flags."],
  },
];

const checklist = [
  {
    title: "Before the dark launch",
    items: [
      "Create the flag with a default of off for external users.",
      "Add explicit internal or test-tenant targeting.",
      "Make flag-provider failure evaluate to off.",
      "Define the branches and failure modes internal traffic must cover.",
      "Define the dark-path error and latency gates.",
    ],
  },
  {
    title: "During the dark period",
    items: [
      "Verify external identities evaluate the off branch.",
      "Check that direct URLs and APIs are not reachable externally.",
      "Run synthetic and internal traffic across the important branches.",
      "Compare dark-path errors and latency with the baseline.",
    ],
  },
  {
    title: "At launch",
    items: [
      "Start with a small exposure ramp and a tested kill switch.",
      "Watch the same signals used during the dark period.",
      "Remove internal-only targeting when the feature is generally available.",
      "Schedule flag cleanup after the rollback window.",
    ],
  },
];

const references = [
  {
    title: "Feature Toggles (aka Feature Flags)",
    url: "https://martinfowler.com/articles/feature-toggles.html",
    publisher: "Martin Fowler",
    kind: "docs" as const,
    note: "Toggle categories, release toggles, and the cost of long-lived flags.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Separating deployment from release and controlling exposure.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "dark-launch": {
      model: darkLaunchModel,
      presets,
      instructions:
        "Start with Healthy, then apply Default on to see exposure and dark-path errors rise. Apply Partial coverage to separate exposure from readiness. Apply Recovery, then run the experiment and its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Exposure, coverage, and error rates are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-feature-flags", "deployment-shadow-traffic", "deployment-canary", "deployment-verification"],
};
