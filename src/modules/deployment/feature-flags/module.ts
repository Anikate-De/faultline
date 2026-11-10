import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "defaultOn",
    label: "Flag default (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Default",
    help: "Value used when no targeting rule matches, or when the flag service cannot be reached. One means every unmatched tenant gets the feature.",
    format: "count",
  },
  {
    id: "targetedTenantsPercent",
    label: "Targeted tenants",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Targeting",
    help: "Share of tenants explicitly turned on by a targeting rule, such as a named allowlist or an internal account segment.",
    format: "percent",
  },
  {
    id: "percentageRollout",
    label: "Percentage rollout of the rest",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Targeting",
    help: "Share of the tenants not already targeted that receive the feature through a percentage rollout. This is not a share of all tenants unless the target list is empty.",
    format: "percent",
  },
  {
    id: "flagAgeDays",
    label: "Flag age",
    min: 0,
    max: 730,
    step: 1,
    value: 14,
    unit: " days",
    group: "Lifecycle",
    help: "Days since the flag was created. Age is a cleanup signal: a permanent flag is configuration, while a release flag should be removed after the rollout.",
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
  defaultOn: boolean;
  target: number;
  rollout: number;
  ageDays: number;
  targetedExposure: number;
  rolloutExposure: number;
  totalExposure: number;
  unreviewedExposure: number;
}

function compute(p: Params): Values {
  const defaultOn = num(p, "defaultOn", 0) >= 0.5;
  const target = clamp(num(p, "targetedTenantsPercent", 10) / 100);
  const rollout = clamp(num(p, "percentageRollout", 0) / 100);
  const ageDays = Math.max(0, num(p, "flagAgeDays", 14));
  const targetedExposure = target * 100;
  const rolloutExposure = (1 - target) * rollout * 100;
  const totalExposure = defaultOn ? 100 : targetedExposure + rolloutExposure;
  const unreviewedExposure = defaultOn ? 100 : 0;

  return {
    defaultOn,
    target,
    rollout,
    ageDays,
    targetedExposure,
    rolloutExposure,
    totalExposure,
    unreviewedExposure,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function ageHealth(days: number): Health {
  if (days >= 180) return "crit";
  if (days >= 90) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function buildFrame(values: Values, seed: number): SimFrame {
  const defaultHealth: Health = values.defaultOn ? "crit" : "ok";
  const fallbackHealth: Health = values.defaultOn ? "crit" : "ok";
  const lifecycle = ageHealth(values.ageDays);
  const overall = worst(defaultHealth, lifecycle);

  const stageNodes = [
    {
      id: "default",
      label: `Default: ${values.defaultOn ? "on" : "off"}`,
      kind: "service" as const,
      health: defaultHealth,
      utilization: values.defaultOn ? 1 : 0,
      sublabel: values.defaultOn ? "Every unmatched tenant is exposed" : "Unmatched tenants stay off",
      detail: values.defaultOn
        ? "A default-on flag exposes the feature to every tenant without a matching rule, including tenants nobody targeted. If the flag service is unavailable, the fallback is also on."
        : "A default-off flag keeps unmatched tenants off. Targeting rules can still turn the feature on for a named group or a percentage of the rest.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "targeted",
      label: "Targeted tenants",
      kind: "service" as const,
      health: "ok" as const,
      utilization: values.target,
      sublabel: `${percent(values.target * 100)} of tenants · explicit rule`,
      detail: "Targeting is an explicit allowlist or segment. It is the smallest safe exposure when the default is off, but it cannot override a default-on fallback for tenants outside the rule.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "rollout",
      label: "Percentage rollout",
      kind: "service" as const,
      health: "ok" as const,
      utilization: values.totalExposure / 100,
      sublabel: `${percent(values.rolloutExposure)} more exposure · total ${percent(values.totalExposure)}`,
      detail: `The percentage rollout applies to tenants not already targeted, adding ${percent(values.rolloutExposure)} of total exposure. Total modeled exposure is ${percent(values.totalExposure)}.`,
      meta: { stage: "full", view: "deployment" },
    },
    {
      id: "lifecycle",
      label: "Flag lifecycle",
      kind: "service" as const,
      health: lifecycle,
      utilization: clamp(values.ageDays / 365),
      sublabel: `${Math.round(values.ageDays)} days old`,
      detail: values.ageDays >= 180
        ? "The flag is old enough to be permanent configuration by accident. Stale release flags multiply test paths and are rarely removed during an incident."
        : "A release flag is temporary. Record an owner and an expiry or removal date when it is created.",
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    {
      id: "clients",
      label: "Client request",
      kind: "client" as const,
      health: "ok" as const,
      meta: { view: "flow" },
    },
    {
      id: "flag-service",
      label: "Flag service",
      kind: "service" as const,
      health: fallbackHealth,
      sublabel: "evaluates targeting",
      detail: "The SDK evaluates the flag locally from a cached ruleset. If the service is unreachable, the default or the last known value decides.",
      meta: { view: "flow" },
    },
    {
      id: "app",
      label: "Application",
      kind: "service" as const,
      health: overall,
      sublabel: values.defaultOn ? "feature exposed broadly" : "feature scoped",
      meta: { view: "flow" },
    },
    {
      id: "feature",
      label: "Feature path",
      kind: "service" as const,
      health: fallbackHealth,
      utilization: values.totalExposure / 100,
      sublabel: `${percent(values.totalExposure)} exposure`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-flag", "clients", "flag-service", 1, fallbackHealth),
      edge("flag-app", "flag-service", "app", 1, overall),
      edge("app-feature", "app", "feature", values.totalExposure / 100, overall),
    ],
    metrics: [
      metric("unreviewed-exposure", "Exposure from default", values.unreviewedExposure, "%", 5, 50, "percent"),
      metric("stale-flag-days", "Flag age", values.ageDays, " days", 90, 180, "count"),
      metric("total-exposure", "Total exposure", values.totalExposure, "%", undefined, undefined, "percent"),
      metric("targeted-exposure", "Targeted exposure", values.targetedExposure, "%", undefined, undefined, "percent"),
      metric("rollout-exposure", "Rollout exposure", values.rolloutExposure, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, defaultOn: values.defaultOn ? 1 : 0 },
    summary: `default ${values.defaultOn ? "on" : "off"} · ${percent(values.totalExposure)} exposed · ${Math.round(values.ageDays)} days old`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const ids = ["unreviewed-exposure", "stale-flag-days", "total-exposure", "targeted-exposure", "rollout-exposure"];
  for (const id of ids) {
    const item = frame.metrics.find((entry) => entry.id === id);
    if (!item) continue;
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      if (item.value === 0) return 0;
      return Math.max(0, item.value * (0.98 + 0.02 * Math.sin((index + (seed % 6)) / 3.3)));
    });
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unreviewed-exposure",
    metricId: "unreviewed-exposure",
    warn: 5,
    crit: 50,
    title: "The flag default is exposing the feature globally",
    cause:
      "A default-on flag applies to every tenant without a matching rule. Targeting a small group does not reduce exposure below the default for everyone else, and the same value applies when the flag service is unreachable.",
    fix:
      "Set the default off, put the intended tenants in explicit targeting, and use a percentage rollout for the rest. Treat a default change as a production configuration change with review and a kill switch.",
    checkFirst: [
      "Check the default value in every environment, including the SDK fallback.",
      "Check which tenants match a targeting rule and which fall through to the default.",
      "Check whether the flag service was unavailable when the exposure changed.",
    ],
  },
  {
    id: "stale-flag-days",
    metricId: "stale-flag-days",
    warn: 90,
    crit: 180,
    title: "The flag is old enough to be permanent debt",
    cause:
      "Release flags are meant to be temporary. A flag that stays after the rollout adds branches, test combinations, and configuration that future responders must reason about, often without an owner.",
    fix:
      "Confirm the flag is still needed. If the feature is fully released, remove the flag and the dead branch. If the flag is now an operational control, document it as configuration with an owner and a review date.",
    checkFirst: [
      "Check the flag owner and the original rollout ticket.",
      "Check whether any tenant or environment still relies on the off state.",
      "Check whether the flag guards a kill switch or a permanent permission rule.",
    ],
  },
];

export const featureFlagsModel: SimModel = {
  id: "deployment-feature-flags",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(values, seed);
    seedSeries(frame, seed);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const next = buildFrame(values, seed);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    next.series = Object.fromEntries(Object.entries(frame.series).map(([seriesKey, valuesAtKey]) => [seriesKey, [...valuesAtKey]]));
    if (frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, seed);
      next.flags.paramsKey = key;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines: string[] = [];
    lines.push(
      `The default is ${values.defaultOn ? "on" : "off"}. ${percent(values.target * 100)} of tenants are explicitly targeted, and the percentage rollout adds ${percent(values.rolloutExposure)} of total exposure.`,
    );
    if (values.defaultOn) {
      lines.push(
        `Total exposure is ${percent(values.totalExposure)} because the default applies to every tenant without a matching rule. Targeting does not reduce exposure below a default-on fallback.`,
      );
    } else {
      lines.push(
        `Total exposure is ${percent(values.totalExposure)}. A default-off flag keeps tenants outside targeting and rollout off, including when the flag service is unreachable.`,
      );
    }
    if (values.ageDays >= 90) {
      lines.push(
        `The flag is ${Math.round(values.ageDays)} days old. A release flag at this age is a cleanup candidate, not just a runtime control.`,
      );
    } else {
      lines.push(`The flag is ${Math.round(values.ageDays)} days old, inside the freshness window used by this model.`);
    }
    lines.push("The default is the fallback under failure. Treat it as production configuration, not as a harmless placeholder.");
    return lines;
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
    description: "Default off, 10 percent of tenants targeted, no percentage rollout, flag is 14 days old.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Wider rollout",
    description: "Default off, 20 percent targeted plus 30 percent of the rest, flag is 120 days old.",
    tone: "warn",
    params: defaults({ targetedTenantsPercent: 20, percentageRollout: 30, flagAgeDays: 120 }),
  },
  {
    id: "failure",
    label: "Default on",
    description: "A new flag was created with the default on. Every tenant is exposed, and the flag is 200 days old.",
    tone: "crit",
    params: defaults({ defaultOn: 1, targetedTenantsPercent: 10, percentageRollout: 0, flagAgeDays: 200 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The default is off, targeting is restored, and the flag has a cleanup date.",
    tone: "ok",
    params: defaults({ defaultOn: 0, targetedTenantsPercent: 10, percentageRollout: 0, flagAgeDays: 30 }),
  },
  {
    id: "stale",
    label: "Stale flag",
    description: "The feature is fully released, but the flag is 400 days old and still in the code.",
    tone: "crit",
    params: defaults({ defaultOn: 0, targetedTenantsPercent: 10, percentageRollout: 100, flagAgeDays: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-default-exposure",
  title: "Predict who sees the feature",
  simId: "flag-console",
  question:
    "A flag is created with the default on, 10 percent of tenants explicitly targeted, and a 0 percent percentage rollout. How many tenants see the feature?",
  prediction: {
    options: [
      { id: "ten", label: "About 10 percent, because only the targeted tenants match" },
      { id: "half", label: "About 55 percent, because targeting and rollout are added" },
      { id: "all", label: "All tenants, because the default applies when no rule matches" },
      { id: "none", label: "Zero, because the percentage rollout is zero" },
    ],
    correctOptionId: "all",
    explanation:
      "The default is the value for every tenant without a matching rule. A 10 percent target list turns the feature on explicitly for that group, but the other 90 percent still fall through to the default, which is on. A default-on flag is global exposure, not a safe baseline.",
  },
  setup: defaults({ defaultOn: 1, targetedTenantsPercent: 10, percentageRollout: 0, flagAgeDays: 200 }),
  runFor: 10,
  observe: [
    "Total exposure is 100 percent, not 10 percent.",
    "Exposure from default is 100 percent and crosses the critical threshold.",
    "The default node is critical even though only 10 percent of tenants are explicitly targeted.",
    "The flag is 200 days old, so the lifecycle threshold is also critical.",
  ],
  explain:
    "Defaults are evaluated after targeting. A tenant that matches no rule gets the default value. When the default is on, targeting a small group does not create a safe cohort; it only distinguishes the group that was reviewed from everyone else. The safe pattern is default off, explicit targeting for the intended cohort, and a percentage rollout for additional exposure.",
  fix: defaults({ defaultOn: 0, targetedTenantsPercent: 10, percentageRollout: 0, flagAgeDays: 14 }),
  debrief:
    "With the default off, exposure falls to the targeted 10 percent. The feature is still deployed to every instance and the code path exists everywhere, but only the intended tenants execute it. Deploy and release are now separate decisions. The tradeoff is that targeting data, flag evaluation, and the default must all be correct; a mistake in any of them changes who sees the feature.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A feature flag is a runtime decision that controls whether a code path is active. The code can be deployed to every instance while the feature stays off. A later change to the flag, not a new deployment, releases it. That separation is the point: deploy is a technical event, release is a product decision, and they no longer have to happen at the same moment.",
  },
  {
    type: "p",
    text: "A flag has a default, targeting rules, a rollout percentage, and an owner. The default is the value used when no rule matches, or when the flag service cannot be reached and the SDK falls back to a cached or configured value. Targeting turns the feature on for named tenants or segments. A percentage rollout exposes a stable share of the remaining population. The default is the most dangerous of these because it applies to everyone the targeting did not name.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The flag service stores rules; a software development kit (SDK) in the application evaluates them per request. The SDK usually caches the ruleset, so the application can evaluate without a network call on every request. That cache is also why a flag service outage does not necessarily stop the application, and why the fallback value matters. If the SDK cannot refresh and has no cached value, it uses its configured default.",
  },
  {
    type: "p",
    text: "Flags also sit in the deployment pipeline as gates. A release flag can be turned on for internal users, then a small tenant cohort, then a percentage, then everyone. The same control can be a kill switch during an incident if the code path is safe to disable. That operational value is why flags persist, and why cleanup matters: every flag adds a branch and a test combination that someone must maintain.",
  },
  {
    type: "compare",
    leftTitle: "Deploy",
    rightTitle: "Release",
    rows: [
      { label: "What changes", left: "Code and configuration reach production", right: "The feature becomes active for a population" },
      { label: "Who decides", left: "Engineering pipeline", right: "Product, support, or an operator with flag access" },
      { label: "Rollback", left: "Deploy the previous artifact", right: "Turn the flag off or change targeting" },
      { label: "Main risk", left: "Broken build or startup", right: "Wrong default or wrong targeting" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Exposure from default: the share of tenants receiving the feature because no rule matched.",
      "Total exposure: targeted tenants plus the percentage rollout of the rest.",
      "Targeted and rollout exposure separately, so the source of exposure is visible.",
      "Flag age as a cleanup signal.",
      "Default, targeted, rollout, and lifecycle nodes with their health.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Default on. Read total exposure before the targeting percentage: a default-on flag exposes every tenant no matter how small the target list is. Apply Stale flag to see the cleanup failure without a default change. Run the experiment to predict exposure, then apply Recovery.",
  },
  {
    type: "table",
    headers: ["Flag control", "What it does", "Failure mode"],
    rows: [
      ["Default", "Value for unmatched tenants and fallback", "Default on exposes everyone"],
      ["Targeting", "Explicitly enables named tenants or segments", "Stale or overly broad rules"],
      ["Percentage rollout", "Exposes a stable share of the rest", "Wrong bucketing or unexpected exposure"],
      ["Kill switch", "Turns the feature off during an incident", "No tested off path or no permission"],
      ["Cleanup", "Removes the flag after the rollout", "Permanent branch and test debt"],
    ],
  },
  {
    type: "p",
    text: "The break condition is a flag default that enables the feature for everyone. A 10 percent target list does not make a default-on flag safe: the other 90 percent receive the default. The same logic applies when the flag service is unreachable and the SDK falls back. The default must be the safe state, and a release flag should start with it off.",
  },
  { type: "sim", simId: "flag-console" },
  { type: "experiment", experimentId: "predict-default-exposure" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the default-on preset, 10 percent of tenants were explicitly targeted, but total exposure was 100 percent. The other 90 percent matched no rule and received the default, which was on. The exposure-from-default metric crossed its critical threshold while the targeting percentage still looked small. This is a configuration incident, not an application defect.",
  },
  {
    type: "p",
    text: "The stale-flag preset showed a separate failure. The feature was fully released through the percentage rollout, so exposure was 100 percent by design, but the flag was 400 days old. The cleanup threshold was critical. The runtime behavior was correct and the engineering debt was still real: the flag had no owner, no removal date, and no reason to remain in the code.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Flag evaluation counts by variation, tenant, and environment.",
      "The current default and targeting rules, with an audit log of who changed them.",
      "SDK fallback events and flag service availability.",
      "Feature-specific error rate and latency for the exposed cohort.",
      "Flag age, owner, and last evaluation time.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the default before the targeting percentage. Confirm which tenants fall through to the default and which match an explicit rule. Check the SDK fallback behavior during a flag service outage, and check whether the flag is old enough to be permanent debt.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Turn the flag off or set the default off, then confirm exposure falls.",
      "Review the targeting rules and the tenants that fell through to the default.",
      "Move the intended cohort into explicit targeting and use a percentage rollout for the rest.",
      "Add an owner, a kill switch, and a removal date to the flag record.",
      "Test the off path and the fallback path, not only the on path.",
      "Remove release flags after the rollout and keep only documented operational controls.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A default-off flag is safe by default but makes the feature unavailable if targeting or the flag service fails.",
      "A default-on flag is available under failure but exposes everyone and removes the safety of the fallback.",
      "Targeting gives precise control but adds tenant data, review, and stale-rule risk.",
      "Percentage rollouts give broad exposure control but depend on stable bucketing and enough users to measure.",
      "Keeping flags enables fast kill switches; removing them reduces branch and test debt. The right answer depends on whether the flag is a release tool or a permanent control.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "flag-default",
    question:
      "A flag has a default of on, a 10 percent tenant target, and no percentage rollout. Who sees the feature, and what do you change?",
    difficulty: 2,
    hints: [
      "Targeting is evaluated before the default.",
      "The default applies to everyone without a matching rule.",
      "The fallback during a flag service outage uses the same default.",
    ],
    answer:
      "Everyone sees it. The 10 percent target gets the feature through an explicit rule, and the other 90 percent fall through to the default, which is on. I would set the default off, keep the intended cohort in targeting, and use a percentage rollout only for the population that should be exposed. I would also check the SDK fallback so a flag service outage does not turn the feature on.",
    followUps: [
      "What if the flag service is unreachable?",
      "How do you test the fallback path?",
      "When would a default-on flag be correct?",
    ],
    redFlags: [
      "Assumes targeting limits exposure below the default.",
      "Ignores the SDK fallback.",
      "Changes the target list instead of the default.",
    ],
    rubric: [
      "Explains default semantics.",
      "Identifies global exposure.",
      "Sets the safe default.",
      "Checks fallback behavior.",
    ],
  },
  {
    id: "flag-cleanup",
    question:
      "How do you decide whether a flag should be removed, kept as configuration, or converted into something else?",
    difficulty: 3,
    hints: [
      "A release flag has a temporary purpose.",
      "An operational flag may be a permanent kill switch.",
      "Ownership and review are part of the answer.",
    ],
    answer:
      "I would look at why the flag exists. A release flag that has been fully rolled out should be removed, along with the dead branch. An operational flag, such as a kill switch for a dependency, may stay, but it needs an owner, a documented default, and a test that proves the off path works. A permission or entitlement flag belongs in the authorization model, not in a release flag. The decision is about the flag's purpose and lifetime, not its age alone.",
    followUps: [
      "Who owns a flag after the release?",
      "How do you find flags that are safe to remove?",
      "What breaks if you remove a flag too early?",
    ],
    redFlags: [
      "Keeps every flag because removal is risky.",
      "Deletes a kill switch as if it were a release flag.",
      "Has no owner or review date.",
    ],
    rubric: [
      "Classifies the flag by purpose.",
      "Assigns ownership.",
      "Tests the off path.",
      "Removes release flags deliberately.",
    ],
  },
  {
    id: "flag-targeting",
    question:
      "A tenant reports they can see an unreleased feature. How do you trace the exposure?",
    difficulty: 3,
    hints: [
      "Check the tenant against every rule in order.",
      "The default applies if no rule matches.",
      "The SDK may be using a cached ruleset.",
    ],
    answer:
      "I would start with the flag evaluation log for that tenant: which variation was returned, which rule matched, and which ruleset version the SDK used. If no rule matched, I would check the default. If a rule matched, I would check whether the targeting segment is broader than intended. I would also check the SDK cache and any fallback behavior, because a stale ruleset can keep an old targeting decision in place after the configuration changed.",
    followUps: [
      "How do you reproduce the evaluation locally?",
      "What if the logs do not record the matched rule?",
      "How would you contain the exposure first?",
    ],
    redFlags: [
      "Changes the tenant ID without checking the rule.",
      "Ignores cached rulesets.",
      "Has no evaluation audit trail.",
    ],
    rubric: [
      "Traces rule evaluation.",
      "Checks the default.",
      "Checks SDK cache.",
      "Contains exposure before debugging.",
    ],
  },
  {
    id: "flag-incident",
    question:
      "The feature behind a flag is causing errors in production. Do you turn the flag off, roll back the deployment, or both?",
    difficulty: 3,
    hints: [
      "The fastest safe control depends on what changed.",
      "A flag off path must be tested to be trusted.",
      "The code remains deployed if you only turn the flag off.",
    ],
    answer:
      "If the flag off path is tested and the feature is the only changed behavior, turning the flag off is the fastest containment and avoids a deployment during the incident. I would confirm that the error rate falls and that the off path does not depend on the failing component. If the defect is in shared code, startup, or the off path itself, a deployment rollback may be the safer action. Either way I would preserve the flag evaluation logs and the deployment event for the review.",
    followUps: [
      "What makes a kill switch trustworthy?",
      "When is a flag change itself too risky during an incident?",
      "How do you verify recovery after turning it off?",
    ],
    redFlags: [
      "Turns off an untested path and assumes it works.",
      "Rolls back everything when a scoped flag change would do.",
      "Does not verify recovery.",
    ],
    rubric: [
      "Chooses the fastest safe control.",
      "Checks the off path.",
      "Verifies recovery.",
      "Preserves evidence.",
    ],
  },
];

const checklist = [
  {
    title: "When creating a flag",
    items: [
      "Set the default to the safe state, usually off for a release flag.",
      "Name an owner and a removal or review date.",
      "Define the intended cohort before adding targeting rules.",
      "Test the on path, the off path, and the fallback path.",
      "Confirm who can change the flag during an incident.",
    ],
  },
  {
    title: "Before release",
    items: [
      "Check the default in every environment, including the SDK fallback.",
      "Review targeting rules for stale or overly broad segments.",
      "Confirm exposure math: targeted plus rollout of the rest.",
      "Check feature-specific error rate and latency for the exposed cohort.",
    ],
  },
  {
    title: "After release",
    items: [
      "Remove the flag and the dead branch if the feature is fully released.",
      "Convert any permanent operational control into documented configuration.",
      "Review flag age and last evaluation time.",
      "Record the exposure and the rollback path in the release notes.",
    ],
  },
];

const references = [
  {
    title: "Feature flags",
    url: "https://docs.launchdarkly.com/home/flags",
    publisher: "LaunchDarkly",
    kind: "docs" as const,
    note: "Flag targeting, defaults, percentage rollouts, and SDK evaluation behavior.",
  },
  {
    title: "Feature Toggles (aka Feature Flags)",
    url: "https://martinfowler.com/articles/feature-toggles.html",
    publisher: "Martin Fowler",
    kind: "docs" as const,
    note: "Release, experiment, ops, and permission toggles, plus the cost of flag debt.",
  },
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Staged exposure, release verification, and rollback during a rollout.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "flag-console": {
      model: featureFlagsModel,
      presets,
      instructions:
        "Start with Healthy, then apply Default on. Read total exposure before the targeting percentage. Apply Stale flag to see the cleanup failure. Run the experiment to predict who sees the feature, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Tenant shares, age thresholds, and exposure thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-dark-launch",
    "deployment-incident-deploy",
    "deployment-canary",
    "deployment-rollback-data-loss",
  ],
};
