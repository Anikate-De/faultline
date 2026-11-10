import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "configInjection",
    label: "Config injected at deploy (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Artifact",
    help: "One means the same artifact starts with configuration supplied by the environment. Zero means configuration is baked into the image.",
    format: "count",
  },
  {
    id: "overrideKeys",
    label: "Environment-specific keys",
    min: 0,
    max: 60,
    step: 1,
    value: 12,
    unit: " keys",
    group: "Config",
    help: "Number of settings that differ between staging and production, such as endpoints, limits, and credentials references.",
    format: "count",
  },
  {
    id: "validationCoverage",
    label: "Deploy-time config validation",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Config",
    help: "Share of configuration keys checked for presence, type, range, and allowed values before the process starts.",
    format: "percent",
  },
  {
    id: "typedSchema",
    label: "Typed config schema (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Config",
    help: "One means the configuration has a declared schema. Zero means unknown keys and wrong types are accepted silently.",
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

interface Values {
  injection: boolean;
  typed: boolean;
  mismatchKeys: number;
  prodErrorRate: number;
  validationGap: number;
  variants: number;
}

function compute(p: Params): Values {
  const injection = num(p, "configInjection", 1) >= 0.5;
  const typed = num(p, "typedSchema", 1) >= 0.5;
  const overrides = Math.max(0, num(p, "overrideKeys", 12));
  const coverage = clamp(num(p, "validationCoverage", 100) / 100, 0, 1);

  const unvalidated = overrides * (1 - coverage) * (typed ? 1 : 1.6);
  const bakedPenalty = injection ? 0 : Math.min(12, 2 + overrides * 0.5);
  const mismatchKeys = Math.max(0, Math.round(unvalidated + bakedPenalty));
  const prodErrorRate = Math.min(30, mismatchKeys * 0.35 + (injection ? 0 : 0.8));

  return {
    injection,
    typed,
    mismatchKeys,
    prodErrorRate,
    validationGap: 100 - coverage * 100,
    variants: injection ? 1 : 4,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 2 : 1)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const configHealth = highHealth(values.mismatchKeys, 3, 10);
  const errorHealth = highHealth(values.prodErrorRate, 0.5, 2);
  const validationHealth = highHealth(values.validationGap, 10, 25);
  const productionHealth = worst(configHealth, errorHealth);

  const stageNodes = [
    {
      id: "artifact",
      label: "One artifact",
      kind: "storage" as const,
      health: values.injection ? ("ok" as Health) : ("warn" as Health),
      utilization: clamp(values.variants / 4),
      sublabel: values.injection ? "sha256:9c1b… · reused" : "config baked · 4 variants",
      detail: values.injection
        ? "The same digest reaches every environment. Configuration is supplied at start time, so the artifact does not change."
        : "Configuration is baked into the image, so each environment needs its own build. The environments now run different artifacts even when the source is identical.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "staging",
      label: "Staging config",
      kind: "service" as const,
      health: validationHealth,
      utilization: clamp(values.validationGap / 100),
      sublabel: `${Math.round(num(p, "overrideKeys", 12))} keys · validated ${percent(100 - values.validationGap)}`,
      detail: "Staging validates its configuration. A key that is valid here can still be missing or different in production.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "production",
      label: "Production config",
      kind: "service" as const,
      health: productionHealth,
      utilization: clamp(values.prodErrorRate / 10),
      sublabel: `${values.mismatchKeys} unvalidated keys · ${percent(values.prodErrorRate)} errors`,
      detail: `Production runs the same source with different configuration. ${values.mismatchKeys} keys differ without validation, and the resulting error rate is ${percent(values.prodErrorRate)}.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "build", label: "Build once", kind: "worker" as const, health: "ok" as Health, sublabel: "artifact digest", meta: { view: "flow" } },
    {
      id: "config",
      label: "Config source",
      kind: "storage" as const,
      health: validationHealth,
      sublabel: `${Math.round(num(p, "overrideKeys", 12))} environment keys`,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "Production service",
      kind: "service" as const,
      health: productionHealth,
      sublabel: values.injection ? "artifact + injected config" : "rebuilt with config",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("build-service", "build", "service", 0.4, productionHealth),
      edge("config-service", "config", "service", clamp(values.validationGap / 100), validationHealth),
    ],
    metrics: [
      metric("config-mismatch", "Unvalidated config keys", values.mismatchKeys, " keys", 3, 10, "count"),
      metric("prod-errors", "Production-only errors", values.prodErrorRate, "%", 0.5, 2, "percent"),
      metric("validation-gap", "Validation gap", values.validationGap, "%", 10, 25, "percent"),
      metric("artifact-variants", "Artifact variants", values.variants, " builds", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), mismatchKeys: values.mismatchKeys },
    summary: `${values.mismatchKeys} unvalidated keys · ${percent(values.prodErrorRate)} production-only errors · ${values.variants} artifact variant${values.variants === 1 ? "" : "s"}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.2);
  for (const [id, value] of [
    ["config-mismatch", values.mismatchKeys],
    ["prod-errors", values.prodErrorRate],
    ["validation-gap", values.validationGap],
    ["artifact-variants", values.variants],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "config-mismatch",
    metricId: "config-mismatch",
    warn: 3,
    crit: 10,
    title: "Environment configuration differs without validation",
    cause: "Configuration is baked into the artifact or injected without a schema. Each environment can carry a different value, and nothing compares the effective configuration before the process starts.",
    fix: "Move configuration out of the artifact, validate every key against a schema at startup, and refuse to start on an unknown or invalid value. Diff effective configuration between staging and production.",
    checkFirst: [
      "Compare effective configuration, not the values in the repository.",
      "Check whether the process validates config before serving traffic.",
      "Check whether the artifact was rebuilt for this environment.",
    ],
  },
  {
    id: "prod-errors",
    metricId: "prod-errors",
    warn: 0.5,
    crit: 2,
    title: "Production fails only in its own configuration",
    cause: "A production-only endpoint, limit, credential reference, or feature default is invalid or points at the wrong dependency. Staging cannot reproduce it because its effective configuration is different.",
    fix: "Roll back the configuration change if it is independent of the artifact. Otherwise roll back the release. Add the missing key to validation and test the production configuration shape in staging.",
    checkFirst: [
      "Compare environment variables and mounted config for the failing service.",
      "Check whether the failure follows the config value or the artifact.",
      "Check dependency endpoints and credentials referenced by production.",
    ],
  },
  {
    id: "validation-gap",
    metricId: "validation-gap",
    warn: 10,
    crit: 25,
    title: "Configuration is not validated before startup",
    cause: "Keys without presence, type, range, or allowed-value checks reach the process. The process may start and fail later, after it receives traffic, which turns a configuration error into an incident.",
    fix: "Define a typed schema for configuration, validate at startup, and fail closed before the readiness check passes. Keep unknown-key handling strict in production.",
    checkFirst: [
      "Check startup logs for accepted but suspicious values.",
      "Check whether readiness passes before config validation completes.",
      "Check whether the schema covers every key in the production manifest.",
    ],
  },
];

export const buildOnceModel: SimModel = {
  id: "deployment-build-once",
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
      values.injection
        ? "Configuration is injected at deploy time, so one artifact can serve every environment."
        : "Configuration is baked into the artifact, so each environment needs its own build and the environments run different software.",
    );
    items.push(
      `${Math.round(num(p, "overrideKeys", 12))} keys differ by environment. Differences are expected; unvalidated differences are the risk.`,
    );
    items.push(
      `Validation coverage is ${percent(100 - values.validationGap)}. Gaps allow a missing or mistyped value to reach the process.`,
    );
    items.push(
      `Unvalidated keys are ${values.mismatchKeys} and production-only errors are ${percent(values.prodErrorRate)}. The error signal follows configuration, not traffic.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Config gap", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "One artifact, twelve injected keys, and full schema validation.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial validation",
    description: "Injection is in place, but a quarter of the environment keys bypass validation.",
    tone: "warn",
    params: defaults({ configInjection: 1, overrideKeys: 30, validationCoverage: 85, typedSchema: 1 }),
  },
  {
    id: "failure",
    label: "Baked config",
    description: "Configuration is baked into four environment builds and validation covers only a fifth of the keys.",
    tone: "crit",
    params: defaults({ configInjection: 0, overrideKeys: 40, validationCoverage: 20, typedSchema: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The artifact is shared, configuration is injected, and every key is validated.",
    tone: "ok",
    params: defaults({ configInjection: 1, overrideKeys: 10, validationCoverage: 100, typedSchema: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-config-separation",
  title: "Predict the fix for a production-only config failure",
  simId: "config-matrix",
  question:
    "Staging passes, production fails after a settings change, and the only way to change a setting was to rebuild the image. What should change first?",
  prediction: {
    options: [
      { id: "inject", label: "Inject validated configuration at deploy time" },
      { id: "rebuild", label: "Rebuild staging with the production settings" },
      { id: "tag", label: "Pin the production image tag" },
      { id: "capacity", label: "Add production instances to absorb the errors" },
    ],
    correctOptionId: "inject",
    explanation:
      "If a setting requires a rebuild, the artifact contains environment state. Moving configuration out of the image lets one tested artifact run everywhere, and validating it at startup catches the difference before traffic arrives. Rebuilding staging reproduces the problem instead of removing it.",
  },
  setup: defaults({ configInjection: 0, overrideKeys: 40, validationCoverage: 20, typedSchema: 0 }),
  runFor: 30,
  observe: [
    "Four artifact variants exist for the same source commit.",
    "Sixty-three effective keys are unvalidated in the failure state.",
    "Production-only errors reach 22.9 percent while the artifact is unchanged.",
    "The validation gap is 80 percent, so readiness can pass before the config is checked.",
  ],
  explain:
    "A build-once pipeline moves environment differences into configuration, not into the artifact. That only works when the configuration is typed and validated at startup. Otherwise the same artifact runs with a bad value and produces a failure that looks production-specific.",
  fix: defaults({ configInjection: 1, overrideKeys: 10, validationCoverage: 100, typedSchema: 1 }),
  debrief:
    "The fix produces one artifact, ten injected keys, and zero unvalidated differences. The tradeoff is that configuration is now a runtime dependency with its own failure modes, so the schema and startup validation are part of the release contract, not an afterthought.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Build once, deploy many means one artifact is promoted through every environment, and the differences between environments live in configuration that is supplied when the process starts. The artifact contains code, dependencies, and static assets. It does not contain the production database endpoint, the staging feature default, or a credential.",
  },
  {
    type: "p",
    text: "Baking configuration into the image forces a rebuild for every environment. Those builds can pick up different base layers or dependency versions, so staging and production no longer run the same software. Even when they do, the effective configuration is buried inside the image and cannot be compared, reviewed, or validated as data. Deploy-time injection makes the difference explicit and lets one validation path run everywhere.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The build system produces the artifact and its digest. A configuration source, such as a parameter store, config map, or secret manager, supplies environment values at deploy time. The process reads configuration at startup, validates it against a schema, and refuses to become ready if a required value is missing or invalid. The deployment controller combines the artifact reference with the environment's configuration reference.",
  },
  {
    type: "p",
    text: "The numbers in this model are illustrative. The lesson is structural: when the artifact is shared, configuration becomes the variable that can still make production different. The useful question is not whether the environments differ, but whether the difference was validated before it could serve traffic.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Artifact variants: one build reused across environments, or one build per environment.",
      "Unvalidated config keys: differences that no schema or check examined.",
      "Production-only errors: failures that do not appear in staging because the effective config differs.",
      "Validation gap: the share of configuration keys without a startup check.",
      "Staging and production configuration nodes with different health.",
    ],
  },
  {
    type: "table",
    headers: ["Approach", "Artifact identity", "Config change", "Failure visibility"],
    rows: [
      ["Baked into image", "One build per environment", "Rebuild and redeploy", "Hidden until production runs"],
      ["Injected at deploy", "One digest everywhere", "Restart or reload with validated values", "Startup check before readiness"],
      ["Injected without schema", "One digest everywhere", "Restart with any accepted value", "May fail after traffic arrives"],
      ["Injected with schema", "One digest everywhere", "Validated before start", "Fails closed before traffic arrives"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and note that the artifact count is one. Apply Baked config: the artifact count rises to four, production-only errors appear, and staging remains green. Apply Partial validation to separate injection from validation. Then run the experiment and apply its fix.",
  },
  { type: "sim", simId: "config-matrix" },
  { type: "experiment", experimentId: "predict-config-separation" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset baked configuration into the image, producing four artifact variants from one commit. Sixty-three effective keys were unvalidated, and production-only errors reached 22.9%. Staging stayed healthy because its image carried different values, not because its code was different. The validation gap meant the process could pass readiness before checking the settings it would use.",
  },
  {
    type: "p",
    text: "The partial-validation preset shows the more common state: the artifact is shared, but some keys bypass the schema. Injection solves artifact identity, not configuration correctness. Both are required for a build-once pipeline to be safe.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Several image builds for one source commit, one per environment.",
      "A production error that disappears when the config value is changed but not when instances are replaced.",
      "Startup logs that accept an unknown key or a string where a number was expected.",
      "Configuration values that differ from the repository and have no review history.",
      "Readiness passing before configuration validation completes.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare effective configuration between staging and production. Check whether the artifact digest is the same. Check whether startup validates every key and fails closed. Check whether a setting change required a rebuild, which is the signal that configuration is inside the artifact.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Remove environment values from the image and inject them at deploy time.",
      "Declare a typed schema for every configuration key.",
      "Validate presence, type, range, and allowed values before readiness.",
      "Keep unknown-key handling strict and fail closed.",
      "Diff effective configuration between environments as part of the promotion gate.",
      "Test a configuration change without rebuilding the artifact.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Injected configuration is reviewable and reusable, but it adds a runtime dependency that can fail independently of the artifact.",
      "Strict validation catches mistakes early but can block a deploy when a non-critical key is missing.",
      "A shared artifact simplifies testing but requires environment differences to be explicit rather than hidden in a build.",
      "Secrets in a config store improve separation but need access control and rotation distinct from image permissions.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rebuild-config",
    question:
      "A setting change requires rebuilding the image. Why is that a problem, and how would you remove the rebuild?",
    difficulty: 2,
    hints: [
      "The artifact should not contain environment state.",
      "Configuration can be read at startup.",
      "Validation has to move with it.",
    ],
    answer:
      "A rebuild means the artifact contains environment-specific state. That produces different bits per environment, weakens the value of staging tests, and makes a setting change a software release. I would move the setting to an external configuration source, inject it at deploy time, and validate it against a typed schema at startup. The same digest can then run in every environment, with the configuration value reviewed and audited separately.",
    followUps: [
      "What belongs in the image and what does not?",
      "How do you handle secrets differently from ordinary config?",
      "What would make a config change still require a restart?",
    ],
    redFlags: ["Keeps rebuilding per environment.", "Puts secrets in the image.", "Injects config without validation."],
    rubric: ["Identifies baked-in state.", "Moves config out.", "Adds validation.", "Separates secrets."],
  },
  {
    id: "prod-only",
    question:
      "Staging and production run the same artifact but only production fails. How do you isolate configuration as the cause?",
    difficulty: 3,
    hints: [
      "Compare effective values, not repository files.",
      "Change one variable at a time.",
      "Check when readiness passed.",
    ],
    answer:
      "I would compare the effective configuration of both environments, including defaults, mounted files, and secret references. If the artifact digest is identical, the remaining differences are configuration, data, traffic, or dependencies. I would reproduce the production configuration in a safe environment, or change one production value behind a flag if that is reversible. I would also check startup validation logs to see whether the bad value was accepted before readiness.",
    followUps: [
      "What if the config is identical too?",
      "How would you reproduce this without a production-like environment?",
      "Which signal tells you the process used the wrong value?",
    ],
    redFlags: ["Assumes code is different.", "Compares only files in Git.", "Changes several values at once."],
    rubric: ["Compares effective config.", "Confirms digest identity.", "Changes one variable.", "Checks readiness and logs."],
  },
  {
    id: "schema",
    question: "What should a deploy-time configuration schema validate, and when should it fail?",
    difficulty: 2,
    hints: [
      "Presence is not enough.",
      "The process should not serve traffic with invalid config.",
      "Some values are only valid in combination.",
    ],
    answer:
      "It should validate required keys, types, ranges, allowed values, and cross-field constraints such as a timeout being shorter than the upstream deadline. It should also reject unknown keys in production when a typo would otherwise be ignored. Validation runs at startup before the readiness check passes, so the instance never receives traffic with invalid configuration. For reloadable config, the same validation runs before the new values are applied.",
    followUps: [
      "Which keys can safely have defaults?",
      "How do you validate a secret without logging it?",
      "What happens when validation fails during a rolling deploy?",
    ],
    redFlags: ["Checks presence only.", "Logs secret values.", "Validates after readiness."],
    rubric: ["Covers types and ranges.", "Mentions cross-field rules.", "Fails before traffic.", "Handles reloads."],
  },
  {
    id: "tradeoff",
    question: "What are the costs of injecting configuration instead of baking it into the image?",
    difficulty: 2,
    hints: [
      "Runtime dependency.",
      "Configuration becomes production data.",
      "Validation and access control are now part of the release.",
    ],
    answer:
      "The artifact becomes portable, but configuration becomes a runtime dependency with its own availability, versioning, and access-control requirements. A bad config value can now affect every environment that shares the source, and a config store outage can prevent startup. The team needs a schema, validation, review, and a rollback path for configuration separate from the artifact. Secrets add rotation and least-privilege concerns.",
    followUps: [
      "How would you version configuration?",
      "What is your rollback path for a bad config value?",
      "How do you keep configuration drift from returning?",
    ],
    redFlags: ["Claims there are no costs.", "Treats config as code but not as production data.", "Ignores availability."],
    rubric: ["Names runtime dependency.", "Mentions validation and review.", "Plans config rollback.", "Addresses secrets."],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Confirm one artifact digest is promoted through every environment.",
      "Keep environment values out of the image and in an external config source.",
      "Define a schema for every key, including types and allowed ranges.",
      "Validate configuration before readiness and fail closed.",
      "Diff effective configuration between staging and production.",
    ],
  },
  {
    title: "During the release",
    items: [
      "Check that the deployed digest matches the approved digest.",
      "Check startup validation results before sending traffic.",
      "Change one configuration value at a time when diagnosing.",
      "Watch for production-only errors that do not follow traffic.",
    ],
  },
  {
    title: "After the release",
    items: [
      "Record the effective configuration with the release outcome.",
      "Review any configuration value changed outside the pipeline.",
      "Add missing keys and constraints to the schema.",
      "Verify that a config-only change can ship without a rebuild.",
    ],
  },
];

const references = [
  {
    title: "The Twelve-Factor App: Config",
    url: "https://12factor.net/config",
    publisher: "12factor.net",
    kind: "docs" as const,
    note: "Store configuration in the environment, separate from code and the build artifact.",
  },
  {
    title: "Configuration Design and Best Practices",
    url: "https://sre.google/workbook/configuration-design/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Configuration as production data, validation, and safe change.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "config-matrix": {
      model: buildOnceModel,
      presets,
      instructions:
        "Start with Healthy, then apply Baked config and compare the artifact count with the production error rate. Apply Partial validation to separate injection from validation, then Recovery. Run the experiment and apply its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Key counts, validation coverage, and error rates are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-immutable-artifacts", "deployment-cicd", "deployment-config-drift", "deployment-feature-flags"],
};
