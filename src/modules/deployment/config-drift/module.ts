import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "manualChangesPerWeek",
    label: "Manual config changes",
    min: 0,
    max: 50,
    step: 1,
    value: 2,
    unit: "/week",
    group: "Change",
    help: "Settings changed outside the reviewed configuration pipeline each week, such as console edits or hotfix scripts.",
    format: "count",
  },
  {
    id: "reconciliationHours",
    label: "Reconciliation interval",
    min: 0,
    max: 168,
    step: 1,
    value: 1,
    unit: "h",
    group: "Control",
    help: "How often desired configuration is compared with the running state. A longer interval lets manual changes accumulate.",
    format: "number",
  },
  {
    id: "diffCoverage",
    label: "Config diff coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Control",
    help: "Share of configuration keys included in the comparison. Uncovered keys can drift indefinitely without being reported.",
    format: "percent",
  },
  {
    id: "runtimeKeyShare",
    label: "Runtime-critical changes",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Change",
    help: "Share of manual changes that touch behavior, such as limits, timeouts, endpoints, or feature defaults.",
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
  driftKeys: number;
  prodErrorRate: number;
  reconcileLag: number;
  manualChanges: number;
  covered: number;
}

function compute(p: Params): Values {
  const manualChanges = Math.max(0, num(p, "manualChangesPerWeek", 2));
  const interval = Math.max(0, num(p, "reconciliationHours", 1));
  const coverage = clamp(num(p, "diffCoverage", 100) / 100, 0, 1);
  const runtimeShare = clamp(num(p, "runtimeKeyShare", 20) / 100, 0, 1);

  const riskyChanges = manualChanges * runtimeShare;
  const accumulation = 1 + interval / 24;
  const driftKeys = Math.max(0, Math.round(riskyChanges * accumulation * (1 - coverage)));
  const prodErrorRate = Math.min(25, driftKeys * 0.12);

  return {
    driftKeys,
    prodErrorRate,
    reconcileLag: interval,
    manualChanges,
    covered: coverage * 100,
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
  return `${value.toFixed(value < 1 ? 2 : 1)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const driftHealth = highHealth(values.driftKeys, 3, 10);
  const errorHealth = highHealth(values.prodErrorRate, 0.5, 2);
  const lagHealth = highHealth(values.reconcileLag, 12, 48);
  const productionHealth = worst(driftHealth, errorHealth);

  const stageNodes = [
    {
      id: "desired",
      label: "Desired config",
      kind: "storage" as const,
      health: "ok" as Health,
      utilization: 0.2,
      sublabel: "reviewed in Git",
      detail: "The desired state is the configuration that passed review. It is the reference for every diff.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "drift",
      label: "Runtime config",
      kind: "service" as const,
      health: driftHealth,
      utilization: clamp(values.driftKeys / 20),
      sublabel: `${values.driftKeys} drifted keys · diff ${percent(values.covered)}`,
      detail: `${values.driftKeys} runtime keys differ from the desired state. ${percent(100 - values.covered)} of keys are outside the diff, so some drift is invisible even when reconciliation runs.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "reconciler",
      label: "Reconciler",
      kind: "service" as const,
      health: lagHealth,
      utilization: clamp(values.reconcileLag / 168),
      sublabel: `last pass ${values.reconcileLag.toFixed(0)}h ago`,
      detail: `Reconciliation runs every ${values.reconcileLag.toFixed(0)} hours. Manual changes made between passes are live until the next comparison.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "git", label: "Config repository", kind: "storage" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "cluster",
      label: "Production config",
      kind: "service" as const,
      health: productionHealth,
      sublabel: `${values.driftKeys} drifted keys`,
      meta: { view: "flow" },
    },
    {
      id: "reconciler-flow",
      label: "Diff and reconcile",
      kind: "worker" as const,
      health: lagHealth,
      sublabel: `${values.covered.toFixed(0)}% coverage`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("git-cluster", "git", "cluster", clamp(values.covered / 100), productionHealth),
      edge("reconciler-cluster", "reconciler-flow", "cluster", clamp(1 - values.reconcileLag / 168), lagHealth),
    ],
    metrics: [
      metric("drift-keys", "Drifted config keys", values.driftKeys, " keys", 3, 10, "count"),
      metric("prod-errors", "Production error rate", values.prodErrorRate, "%", 0.5, 2, "percent"),
      metric("reconcile-lag", "Reconciliation lag", values.reconcileLag, "h", 12, 48, "number"),
      metric("manual-changes", "Manual changes per week", values.manualChanges, "/week", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), driftKeys: values.driftKeys },
    summary: `${values.driftKeys} drifted keys · ${percent(values.prodErrorRate)} production errors · reconciliation ${values.reconcileLag.toFixed(0)}h ago`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 6)) / 2.6);
  for (const [id, value] of [
    ["drift-keys", values.driftKeys],
    ["prod-errors", values.prodErrorRate],
    ["reconcile-lag", values.reconcileLag],
    ["manual-changes", values.manualChanges],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "drift-keys",
    metricId: "drift-keys",
    warn: 3,
    crit: 10,
    title: "Runtime configuration has drifted from the desired state",
    cause: "Manual changes, console edits, or hotfix scripts changed settings outside the reviewed path. With a slow reconciliation interval or incomplete diff, the changes accumulate and production no longer matches any reviewed configuration.",
    fix: "Run a full diff against the desired state, reconcile the differences, and record who changed each key. Reduce the reconciliation interval and cover every key. Move emergency changes through a reviewed exception path that writes back to the source of truth.",
    checkFirst: [
      "Diff runtime values against the desired configuration, key by key.",
      "Check audit logs for console or script changes since the last deploy.",
      "Check whether the diff covers the keys involved in the failure.",
    ],
  },
  {
    id: "prod-errors",
    metricId: "prod-errors",
    warn: 0.5,
    crit: 2,
    title: "A drifted setting is causing production errors",
    cause: "A runtime-critical value such as a timeout, limit, endpoint, or feature default differs from the reviewed value. Staging uses the reviewed value, so the failure does not reproduce there.",
    fix: "Restore the reviewed value or roll back the change. Confirm the error rate follows the value, then reconcile the full configuration. Add the key to the diff and require review for future changes.",
    checkFirst: [
      "Compare the failing service's effective values with staging.",
      "Check whether reverting one key clears the errors.",
      "Check when the value last changed and who changed it.",
    ],
  },
  {
    id: "reconcile-lag",
    metricId: "reconcile-lag",
    warn: 12,
    crit: 48,
    title: "Reconciliation is too slow to catch drift",
    cause: "The comparison interval is long relative to the rate of manual change. Even a correct diff runs after users have already been exposed to the drifted configuration.",
    fix: "Reconcile more frequently and alert on drift before the next scheduled pass. Use admission control to reject unreviewed runtime changes where possible.",
    checkFirst: [
      "Check the last successful reconciliation time.",
      "Compare the interval with the rate of manual changes.",
      "Check whether reconciliation errors are being retried or ignored.",
    ],
  },
];

export const configDriftModel: SimModel = {
  id: "deployment-config-drift",
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
      `${values.manualChanges} manual changes per week, with ${percent(num(p, "runtimeKeyShare", 20))} touching runtime behavior.`,
    );
    items.push(
      `Reconciliation runs every ${values.reconcileLag.toFixed(0)} hours and covers ${percent(values.covered)} of keys. Changes made in the gap are live before they are compared.`,
    );
    items.push(
      `Drift is ${values.driftKeys} keys and the production error rate is ${percent(values.prodErrorRate)}. Staging stays clean because it shares the desired state, not the drifted one.`,
    );
    items.push(
      "Drift is not the same as an intentional override. The difference is whether the value is declared, reviewed, and visible in the diff.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Drifted", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Two manual changes a week, hourly reconciliation, and a complete diff.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow diff",
    description: "Twenty changes a week and a daily reconciliation that covers most keys.",
    tone: "warn",
    params: defaults({ manualChangesPerWeek: 20, reconciliationHours: 24, diffCoverage: 70, runtimeKeyShare: 30 }),
  },
  {
    id: "failure",
    label: "Drifted production",
    description: "A week between reconciliations, incomplete diff coverage, and frequent runtime edits.",
    tone: "crit",
    params: defaults({ manualChangesPerWeek: 40, reconciliationHours: 168, diffCoverage: 30, runtimeKeyShare: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Config as code, hourly reconciliation, and a complete diff.",
    tone: "ok",
    params: defaults({ manualChangesPerWeek: 5, reconciliationHours: 1, diffCoverage: 100, runtimeKeyShare: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-drift-detection",
  title: "Predict how to find the production-only setting",
  simId: "config-drift",
  question:
    "Staging and production have diverged for months. Applications behave differently and no one knows which setting changed. What is the most reliable first move?",
  prediction: {
    options: [
      { id: "diff", label: "Diff runtime configuration against the reviewed desired state" },
      { id: "restart", label: "Restart production to reset the configuration" },
      { id: "rebuild", label: "Rebuild staging with more logging" },
      { id: "capacity", label: "Add instances until the error rate falls" },
    ],
    correctOptionId: "diff",
    explanation:
      "Drift is a difference between the reviewed desired state and the running state. A full diff identifies the keys that differ and gives you an audit target. Restarting may reload the drifted value or make the change disappear, and more capacity does not explain a behavior difference.",
  },
  setup: defaults({ manualChangesPerWeek: 25, reconciliationHours: 48, diffCoverage: 0, runtimeKeyShare: 40 }),
  runFor: 30,
  observe: [
    "Thirty runtime keys differ from the desired state.",
    "Diff coverage is zero, so the reconciler cannot report any of them.",
    "Production errors reach 3.6% while staging remains healthy.",
    "Reconciliation lag is 48 hours, so manual changes are live long before comparison.",
  ],
  explain:
    "Without a diff, drift is invisible until behavior changes. The fix is not more frequent deploys; it is a comparison against a reviewed desired state, complete key coverage, and a reconciliation loop that reports or reverts differences.",
  fix: defaults({ manualChangesPerWeek: 5, reconciliationHours: 1, diffCoverage: 100, runtimeKeyShare: 10 }),
  debrief:
    "The fixed state has hourly reconciliation and a complete diff, so a manual change is visible within an hour. The tradeoff is that reconciliation can revert an intentional emergency change. The exception path, not a wider diff gap, is what preserves safety.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Configuration drift is the difference between the configuration a system is supposed to have and the configuration it is actually running. It comes from console edits, hotfix scripts, manually changed limits, or a deployment that applied only part of a desired state. Drift is not automatically a mistake: an intentional override is a declared, reviewed difference. The problem is an undeclared difference that nobody can see.",
  },
  {
    type: "p",
    text: "Drift accumulates between comparisons. If reconciliation runs once a day and operators make several changes a week, production can run a value that no environment ever tested. A partial diff is worse than no diff in one respect: it creates confidence that the configuration is covered when some keys are outside the comparison entirely.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A desired-state source, usually version-controlled configuration, defines what reviewed values should be. A reconciler compares that source with the running system and either reports the difference or applies the desired value. Admission control can reject changes that did not come through the source. Audit logs record who changed a key and when.",
  },
  {
    type: "p",
    text: "This model's change rate, key counts, and error rates are illustrative. The structural point is that drift is a function of change rate, reconciliation interval, and diff coverage. Reducing any one of them reduces surprise, but only complete coverage lets you say that no key drifted.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Drifted config keys: runtime values that differ from the desired state.",
      "Reconciliation lag: how long since the last comparison.",
      "Diff coverage: the share of keys the comparison can see.",
      "Production error rate: the user-visible consequence of a runtime-critical drift.",
      "A reconciler node whose health follows the interval and coverage.",
    ],
  },
  {
    type: "table",
    headers: ["State", "Desired source", "Runtime", "Diagnosis"],
    rows: [
      ["In sync", "Reviewed value", "Same value", "No action"],
      ["Intentional override", "Declared exception", "Different, reviewed", "Visible and owned"],
      ["Drift", "Reviewed value", "Different, unreviewed", "Diff and reconcile"],
      ["Invisible drift", "Reviewed value", "Different, outside diff", "Extend coverage first"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Slow diff: drift is small but reconciliation lag is visible. Apply Drifted production to see production errors rise while staging stays clean. Apply Recovery and then run the experiment. Compare the drift count with the diff coverage before trusting a clean report.",
  },
  { type: "sim", simId: "config-drift" },
  { type: "experiment", experimentId: "predict-drift-detection" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, 40 manual changes a week and a week-long reconciliation interval left 112 keys drifted. The diff covered 30% of keys, so most of that drift was invisible even when reconciliation ran. Production errors reached 13.4% while staging stayed healthy because staging shared the reviewed desired state.",
  },
  {
    type: "p",
    text: "The recovery preset did not deploy a different application. It reduced the change rate, reconciled hourly, and covered every key. Drift fell to zero, and production errors returned to baseline. The control is the comparison loop, not the deploy frequency.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A production value that differs from the one in the reviewed configuration.",
      "An audit log entry from a console or script change with no linked review.",
      "A staging environment that behaves correctly because it never received the change.",
      "A reconciliation job that is disabled, failing, or covering only part of the keys.",
      "A behavior difference that follows a restart or a config reload.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Diff effective runtime configuration against the desired state. Check the last successful reconciliation and whether the failing key is in the diff. Check audit logs for manual changes since the last deploy. Restore the reviewed value only after you know whether the drift was intentional.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the current runtime configuration and diff it against the desired state.",
      "Restore the reviewed value or roll back the drift if it is causing errors.",
      "Extend the diff to every key and reduce the reconciliation interval.",
      "Route emergency changes through a reviewed exception that writes back to the source.",
      "Alert on drift before the next scheduled reconciliation when the key is runtime-critical.",
      "Review the change rate and remove manual paths that no longer need to exist.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Frequent reconciliation catches drift sooner but costs compute and can revert a deliberate emergency change.",
      "Complete diff coverage is safer but requires maintaining a schema for every key, including secrets references.",
      "Automatic reconciliation reduces drift but can amplify a bad desired-state change to every environment.",
      "Strict admission prevents manual fixes but can slow incident response; an audited exception path is the compromise.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-drift",
    question:
      "A service behaves differently in production after months of manual changes. How do you find the drifted setting?",
    difficulty: 2,
    hints: [
      "Compare desired and actual configuration.",
      "Use audit history, not memory.",
      "Check whether the key is inside the diff.",
    ],
    answer:
      "I would capture the effective runtime configuration and diff it against the reviewed desired state, key by key. If the failing key is outside the diff, I would extend coverage before drawing conclusions. I would check audit logs for recent console or script changes and compare the value with staging. Once I find the difference, I would confirm causality by reverting that one value or reproducing it in a safe environment.",
    followUps: [
      "What if the values match but behavior differs?",
      "How do you tell an intentional override from drift?",
      "What would you change so this is found automatically?",
    ],
    redFlags: ["Restarts production without a diff.", "Assumes only code changed.", "Trusts a partial diff."],
    rubric: ["Diffs desired and actual.", "Checks coverage.", "Uses audit history.", "Confirms causality with one change."],
  },
  {
    id: "reconcile-cadence",
    question: "How do you choose a reconciliation interval and diff coverage?",
    difficulty: 3,
    hints: [
      "Start from the change rate and the impact of a bad key.",
      "Coverage matters more than frequency for invisible keys.",
      "Reconciliation cost is not the only cost.",
    ],
    answer:
      "I would start from the rate of manual changes and the blast radius of the keys involved. Runtime-critical keys need detection before the next user impact, which may mean continuous or event-driven comparison rather than a fixed interval. Coverage must include every key that can change behavior; a fast diff over half the keys is not a control. I would also measure reconciliation latency, false reverts, and the time from a manual change to detection.",
    followUps: [
      "Which keys would you exclude from reconciliation?",
      "How do you handle a config value that must differ by environment?",
      "What alert would you create for reconciliation failure?",
    ],
    redFlags: ["Picks an interval by habit.", "Optimizes only cost.", "Excludes keys without an owner."],
    rubric: ["Uses change rate and impact.", "Prioritizes complete coverage.", "Measures detection time.", "Handles exceptions."],
  },
  {
    id: "gitops-revert",
    question:
      "GitOps reconciliation reverts a manual hotfix during an incident. Was GitOps wrong?",
    difficulty: 3,
    hints: [
      "Reconciliation is doing what it was configured to do.",
      "The exception path is part of the design.",
      "The incident process and the deploy process have to meet.",
    ],
    answer:
      "GitOps was not wrong; the process lacked an exception path. Reconciliation correctly restored the declared state, but the hotfix was applied outside the source of truth. The safe pattern is to make the emergency change through a reviewed, time-bounded exception that updates the source or pauses reconciliation with an owner and expiry. After the incident, the change is either promoted or removed deliberately.",
    followUps: [
      "How would you pause reconciliation safely?",
      "What prevents an exception from becoming permanent?",
      "How do you audit a paused reconciliation?",
    ],
    redFlags: ["Disables reconciliation permanently.", "Blames the tool.", "Leaves the manual change unowned."],
    rubric: ["Explains reconciliation behavior.", "Adds a bounded exception.", "Assigns ownership.", "Restores the source of truth."],
  },
  {
    id: "prevent",
    question: "How do you prevent drift rather than detect it after the fact?",
    difficulty: 2,
    hints: [
      "Remove the manual path.",
      "Make the reviewed path the easy path.",
      "Prevention still needs detection.",
    ],
    answer:
      "I would remove write access to production configuration outside the pipeline, make the reviewed path fast enough for emergencies, and require every override to be declared with an owner and expiry. Admission control can reject unknown keys. Detection still matters because credentials, mounted files, and external systems can change outside the main path. Prevention reduces the rate; reconciliation catches what remains.",
    followUps: [
      "What would you do about break-glass access?",
      "How do you keep the reviewed path fast?",
      "Which drift cannot be prevented by admission control?",
    ],
    redFlags: ["Relies only on detection.", "Removes break-glass entirely.", "Ignores external config."],
    rubric: ["Removes manual paths.", "Keeps an emergency path.", "Adds admission control.", "Keeps detection."],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Confirm every runtime key is represented in the desired-state source.",
      "Define which keys may differ by environment and who owns each exception.",
      "Set a reconciliation interval from the change rate and key impact.",
      "Confirm the diff covers secrets references and mounted files.",
      "Test that reconciliation reports or reverts an undeclared change.",
    ],
  },
  {
    title: "During the release",
    items: [
      "Diff effective configuration before and after the deploy.",
      "Check reconciliation health and the last successful pass.",
      "Route emergency changes through the audited exception path.",
      "Watch for behavior differences that follow a single config value.",
    ],
  },
  {
    title: "After the release",
    items: [
      "Record every override with an owner and expiry.",
      "Review manual changes since the last reconciliation.",
      "Close gaps in diff coverage found during the release.",
      "Verify that intentional overrides remain visible and declared.",
    ],
  },
];

const references = [
  {
    title: "Configuration Design and Best Practices",
    url: "https://sre.google/workbook/configuration-design/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Configuration as production data, with validation and controlled change.",
  },
  {
    title: "Argo CD documentation",
    url: "https://argo-cd.readthedocs.io/en/stable/",
    publisher: "Argo CD",
    kind: "docs" as const,
    note: "Declarative desired state, drift detection, and reconciliation.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "config-drift": {
      model: configDriftModel,
      presets,
      instructions:
        "Start with Healthy, then apply Slow diff to see reconciliation lag. Apply Drifted production to separate drift from the deploy. Apply Recovery, then run the experiment and apply its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Change rates, key counts, intervals, and error rates are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-build-once", "deployment-gitops", "deployment-incident-deploy", "deployment-change-management"],
};
