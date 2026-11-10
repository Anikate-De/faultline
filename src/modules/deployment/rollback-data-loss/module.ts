import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "writesPerMinute",
    label: "New version write rate",
    min: 0,
    max: 5_000,
    step: 20,
    value: 120,
    unit: "/min",
    group: "Data",
    help: "Records the new version writes per minute while it serves traffic. A rollback cannot automatically undo these writes.",
    format: "count",
  },
  {
    id: "rollbackDelayMinutes",
    label: "Time before rollback completes",
    min: 1,
    max: 120,
    step: 1,
    value: 10,
    unit: "min",
    group: "Recovery",
    help: "Minutes the new version keeps serving and writing before the rollback takes effect, including detection and execution.",
    format: "number",
  },
  {
    id: "compensationCoverage",
    label: "Compensation coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Recovery",
    help: "Share of writes and external effects that have a tested compensating action, such as reversal, reconciliation, or a correction message.",
    format: "percent",
  },
  {
    id: "externalEffectsPerMinute",
    label: "External effects",
    min: 0,
    max: 500,
    step: 10,
    value: 20,
    unit: "/min",
    group: "Side effects",
    help: "Emails, payments, webhooks, or third-party calls the new version triggers per minute. These leave the system and cannot be rolled back.",
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
  writes: number;
  delay: number;
  coverage: number;
  external: number;
  uncompensatedWrites: number;
  duplicateEffects: number;
  unrecoverableWindow: number;
}

function compute(p: Params): Values {
  const writes = Math.max(0, num(p, "writesPerMinute", 120));
  const delay = Math.max(1, num(p, "rollbackDelayMinutes", 10));
  const coverage = clamp(num(p, "compensationCoverage", 100) / 100, 0, 1);
  const external = Math.max(0, num(p, "externalEffectsPerMinute", 20));

  const uncompensated = 1 - coverage;
  return {
    writes,
    delay,
    coverage,
    external,
    uncompensatedWrites: Math.round(writes * delay * uncompensated),
    duplicateEffects: Math.round(external * delay * uncompensated),
    unrecoverableWindow: delay * uncompensated,
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
  return `${value.toFixed(value < 1 ? 0 : 1)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const dataHealth = highHealth(values.uncompensatedWrites, 500, 5_000);
  const effectHealth = highHealth(values.duplicateEffects, 50, 500);
  const windowHealth = highHealth(values.unrecoverableWindow, 5, 20);
  const overall = worst(dataHealth, effectHealth, windowHealth);

  const stageNodes = [
    {
      id: "new",
      label: "New version",
      kind: "service" as const,
      health: overall,
      utilization: clamp(values.delay / 120),
      sublabel: `${values.writes.toFixed(0)} writes/min · ${values.external.toFixed(0)} external/min`,
      detail: `The new version writes ${values.writes.toFixed(0)} records and triggers ${values.external.toFixed(0)} external effects per minute. Rollback stops the writes; it does not undo them.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "rollback",
      label: "Rollback",
      kind: "service" as const,
      health: windowHealth,
      utilization: clamp(values.delay / 120),
      sublabel: `${values.delay.toFixed(0)} min · ${percent(values.unrecoverableWindow)} min unrecoverable`,
      detail: `The rollback takes ${values.delay.toFixed(0)} minutes to complete. Writes made during that window need compensation if the new version's data is not compatible with the old code.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "ledger",
      label: "Side-effect ledger",
      kind: "db" as const,
      health: worst(dataHealth, effectHealth),
      utilization: clamp(values.uncompensatedWrites / 10_000),
      sublabel: `${values.uncompensatedWrites.toLocaleString()} uncompensated · ${values.duplicateEffects.toLocaleString()} external`,
      detail: `Compensation covers ${percent(values.coverage * 100)} of effects. The remaining ${values.uncompensatedWrites.toLocaleString()} write operations and ${values.duplicateEffects.toLocaleString()} external effects need manual reconciliation or a correction job.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "traffic", label: "Traffic", kind: "client" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "app",
      label: "New version",
      kind: "service" as const,
      health: overall,
      sublabel: `${values.writes.toFixed(0)} writes/min`,
      meta: { view: "flow" },
    },
    {
      id: "external",
      label: "External systems",
      kind: "external" as const,
      health: effectHealth,
      sublabel: `${values.duplicateEffects.toLocaleString()} uncorrected effects`,
      meta: { view: "flow" },
    },
    {
      id: "comp",
      label: "Compensation job",
      kind: "worker" as const,
      health: windowHealth,
      sublabel: `${percent(values.coverage * 100)} covered`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("traffic-app", "traffic", "app", clamp(values.writes / 5_000), overall),
      edge("app-external", "app", "external", clamp(values.duplicateEffects / 1_000), effectHealth),
      edge("comp-external", "comp", "external", clamp(values.coverage), windowHealth),
    ],
    metrics: [
      metric("uncompensated-writes", "Uncompensated writes", values.uncompensatedWrites, " records", 500, 5_000, "count"),
      metric("duplicate-effects", "Irreversible external effects", values.duplicateEffects, " effects", 50, 500, "count"),
      metric("unrecoverable-window", "Unrecoverable window", values.unrecoverableWindow, "min", 5, 20, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), uncompensatedWrites: values.uncompensatedWrites },
    summary: `${values.uncompensatedWrites.toLocaleString()} uncompensated writes · ${values.duplicateEffects.toLocaleString()} external effects · ${values.unrecoverableWindow.toFixed(0)} min window`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.4);
  for (const [id, value] of [
    ["uncompensated-writes", values.uncompensatedWrites],
    ["duplicate-effects", values.duplicateEffects],
    ["unrecoverable-window", values.unrecoverableWindow],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "uncompensated-writes",
    metricId: "uncompensated-writes",
    warn: 500,
    crit: 5_000,
    title: "Writes have no compensating action",
    cause: "The new version wrote records that the rollback does not reverse. The old code may not understand the new shape, and the data remains after the software is restored.",
    fix: "Stop the new writes first, then run a tested compensation or reconciliation job. Make the next release write a backward-compatible shape and record enough intent to reverse or correct each write.",
    checkFirst: [
      "Count records written during the rollback window.",
      "Check whether the old code can read the new records.",
      "Check whether a compensation job exists and has been tested.",
    ],
  },
  {
    id: "duplicate-effects",
    metricId: "duplicate-effects",
    warn: 50,
    crit: 500,
    title: "External side effects cannot be rolled back",
    cause: "The new version sent emails, charged cards, emitted webhooks, or called a third party. Restoring the old code does not recall those effects, and a retry can repeat them.",
    fix: "Inventory every external call, use idempotency keys, and define a compensating action. For the current incident, reconcile the external ledger and notify the owners. Do not replay the traffic until duplicate protection is in place.",
    checkFirst: [
      "List external calls made during the window.",
      "Check whether each call carries an idempotency key.",
      "Check the provider ledger for duplicates and reconcile them.",
    ],
  },
  {
    id: "unrecoverable-window",
    metricId: "unrecoverable-window",
    warn: 5,
    crit: 20,
    title: "The rollback window is too long",
    cause: "Detection and rollback take longer than the data compatibility window. More writes and external effects accumulate before the old version is back, widening the set that needs compensation.",
    fix: "Shorten detection and rollback, drain writes before switching versions, and make the new data backward compatible. The window should be shorter than the time it takes for incompatible effects to accumulate.",
    checkFirst: [
      "Measure detection plus rollback time.",
      "Check whether writes continue during the switch.",
      "Check whether the old version can read data written during the window.",
    ],
  },
];

export const rollbackDataLossModel: SimModel = {
  id: "deployment-rollback-data-loss",
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
      `Rollback restores the artifact, not the ${values.uncompensatedWrites.toLocaleString()} records written during the window or the ${values.duplicateEffects.toLocaleString()} external effects already sent.`,
    );
    items.push(
      `Compensation covers ${percent(values.coverage * 100)} of effects. The rest need manual reconciliation or a correction job.`,
    );
    items.push(
      `The unrecoverable window is ${values.unrecoverableWindow.toFixed(0)} minutes: ${values.delay.toFixed(0)} minutes of delay times the uncompensated share.`,
    );
    items.push(
      "The safe rollback plan names which effects are reversible, which need compensation, and who owns the reconciliation.",
    );
    return items;
  },
  legend: [
    { label: "Reversible", tone: "ok" },
    { label: "Needs reconciliation", tone: "warn" },
    { label: "Irreversible", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Low write volume, a one-minute rollback, and complete compensation.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial compensation",
    description: "Eight hundred writes a minute, a ten-minute window, and ninety percent coverage.",
    tone: "warn",
    params: defaults({ writesPerMinute: 800, rollbackDelayMinutes: 10, compensationCoverage: 90, externalEffectsPerMinute: 20 }),
  },
  {
    id: "failure",
    label: "No compensation",
    description: "High write volume, a long rollback, and only a fifth of effects covered.",
    tone: "crit",
    params: defaults({ writesPerMinute: 3_000, rollbackDelayMinutes: 30, compensationCoverage: 20, externalEffectsPerMinute: 200 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Writes drained, rollback shortened, and every effect compensable.",
    tone: "ok",
    params: defaults({ writesPerMinute: 120, rollbackDelayMinutes: 2, compensationCoverage: 100, externalEffectsPerMinute: 20 }),
  },
  {
    id: "drain-first",
    label: "Drain first",
    description: "A short window bounds the damage, but uncompensated writes and external effects remain.",
    tone: "warn",
    params: defaults({ writesPerMinute: 3_000, rollbackDelayMinutes: 1, compensationCoverage: 0, externalEffectsPerMinute: 200 }),
  },
];

const experiment: Experiment = {
  id: "predict-rollback-boundary",
  title: "Predict what rollback cannot restore",
  simId: "rollback-data-loss",
  question:
    "A rollback restores the previous code, but the new version already sent emails and wrote orders. What is still broken after the rollback?",
  prediction: {
    options: [
      { id: "effects", label: "The external effects and new data that the old code cannot reconcile" },
      { id: "artifact", label: "The previous artifact, which the rollback replaced" },
      { id: "traffic", label: "The load balancer's routing table" },
      { id: "config", label: "The environment configuration applied at deploy" },
    ],
    correctOptionId: "effects",
    explanation:
      "Rollback restores software, not the external world. Emails, payments, webhooks, and new records remain. If the old code cannot read or reconcile them, the rollback restores the code and leaves the data problem in place.",
  },
  setup: defaults({ writesPerMinute: 3_000, rollbackDelayMinutes: 30, compensationCoverage: 20, externalEffectsPerMinute: 200 }),
  runFor: 30,
  observe: [
    "Seventy-two thousand writes are uncompensated.",
    "Four thousand eight hundred external effects cannot be recalled.",
    "The unrecoverable window is 24 minutes.",
    "The old artifact is restored, but the data and external effects remain.",
  ],
  explain:
    "A rollback plan has to cover three layers: the artifact, the data the new version wrote, and the effects that left the system. The artifact is the easy part. Data needs backward compatibility or compensation, and external effects need idempotency and a reconciliation path.",
  fix: defaults({ writesPerMinute: 120, rollbackDelayMinutes: 2, compensationCoverage: 100, externalEffectsPerMinute: 20 }),
  debrief:
    "The fixed state drains writes, shortens the window, and covers every effect with compensation. The tradeoff is that compensation work has to be designed and tested before the release, and some external effects, such as an email already read, can only be corrected rather than undone.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Rollback restores the previous software. It does not restore the state the new software changed. If the new version wrote orders, sent emails, charged cards, published events, or called a partner API, those effects remain after the old artifact is running. Some can be reversed; some can only be compensated; some cannot be undone at all.",
  },
  {
    type: "p",
    text: "This is why a rollback plan needs a data and side-effect boundary, not just an artifact. The boundary is the set of effects that are safe to leave, safe to reverse, or require a compensating action. During a mixed-version window, the old code may also be unable to read data written by the new version, so restoring the artifact can produce a new failure.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The rollback controller restores the artifact and configuration. The database, event bus, and external providers hold the effects. A compensation job or reconciliation process handles what the rollback cannot. The incident timeline must record when writes stopped, when the old version took over, and which effects were produced in between.",
  },
  {
    type: "p",
    text: "The rates and coverage values here are illustrative. The structural rule is that the unrecoverable window is the time between the first bad effect and the last one, and compensation coverage determines how much of that window can be corrected.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Uncompensated writes: records the rollback leaves behind.",
      "Irreversible external effects: emails, payments, webhooks, or partner calls already sent.",
      "Unrecoverable window: how long the new version kept producing effects.",
      "Compensation coverage: the share of effects with a tested corrective action.",
      "A ledger node that separates reversible data from external side effects.",
    ],
  },
  {
    type: "table",
    headers: ["Effect", "Rollback restores it?", "Corrective action"],
    rows: [
      ["Artifact and config", "Yes", "Restore previous digest and config"],
      ["Database row", "Only if compatible", "Reverse, correct, or backfill"],
      ["Sent email", "No", "Send a correction if appropriate"],
      ["Payment capture", "No", "Refund or void through the provider"],
      ["Published event", "No", "Compensating event or consumer correction"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Partial compensation. Apply No compensation to see writes and external effects accumulate while the artifact is restored. Apply Drain first to separate a short window from missing compensation. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "rollback-data-loss" },
  { type: "experiment", experimentId: "predict-rollback-boundary" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the rollback took 30 minutes and compensation covered 20% of effects. The new version wrote 72,000 uncompensated records and produced 4,800 external effects. The artifact was restored, but the data and the external world were not.",
  },
  {
    type: "p",
    text: "The drain-first preset shows that a short window helps but is not enough. With no compensation, a one-minute window still left 3,000 writes and 200 external effects. The window bounds the damage; compensation determines whether the remaining damage can be corrected.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Emails or notifications sent by a version that is no longer running.",
      "Orders or rows that the old code cannot read or that duplicate an earlier record.",
      "Payments captured twice after a retry.",
      "Consumers processing events produced by the new schema.",
      "A rollback that restores health checks but not data correctness.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "List the external effects and writes produced during the window. Check whether the old code can read the new data. Check idempotency keys and provider ledgers for duplicates. Stop new writes before restoring the old version, and assign an owner for reconciliation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop or drain new writes before switching versions.",
      "Restore the artifact and configuration.",
      "Run a tested compensation or reconciliation job for writes and external effects.",
      "Check provider ledgers for duplicates and correct them.",
      "Verify the old code can read all data written during the window.",
      "Add idempotency, backward compatibility, and a shorter rollback window before retrying.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Draining writes before rollback reduces damage but extends user impact.",
      "Compensation adds engineering work and cannot undo an effect a person already saw.",
      "Backward-compatible data lets the old code read new records but adds schema complexity.",
      "A shorter rollback window limits effects but may force a faster, less verified decision.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-remains",
    question:
      "A rollback restored the old code. What would you check before declaring the incident resolved?",
    difficulty: 3,
    hints: [
      "Data written by the new version.",
      "External effects already sent.",
      "Consumers and downstream ledgers.",
    ],
    answer:
      "I would check the data written during the new version's lifetime, whether the old code can read it, and whether any records need reversal or correction. I would inventory external effects such as emails, payments, webhooks, and partner calls, then check the provider ledgers for duplicates. I would also check downstream consumers for events produced by the new schema. The incident is resolved only when the data and external effects are reconciled, not just when the old artifact is healthy.",
    followUps: [
      "What if the old code cannot read the new rows?",
      "How do you correct an email that was already sent?",
      "Who owns the reconciliation?",
    ],
    redFlags: ["Declares resolution at healthy pods.", "Ignores external providers.", "Does not check data compatibility."],
    rubric: ["Checks data.", "Inventories external effects.", "Checks duplicates.", "Assigns reconciliation."],
  },
  {
    id: "compensation",
    question: "How do you design compensating actions for a release that sends emails and charges cards?",
    difficulty: 3,
    hints: [
      "Idempotency before the effect.",
      "A ledger of what was sent.",
      "Some effects are correction-only.",
    ],
    answer:
      "I would give every external call an idempotency key and record the intent and outcome in a ledger before and after the call. For charges, the compensation is a refund or void through the provider. For emails, it may be a correction notice rather than an unsend. For events, it is a compensating event or a consumer correction. The design must say which effects are reversible, which are correctable, and which are permanent, and it must be tested in a sandbox.",
    followUps: [
      "What if the provider does not support idempotency?",
      "How do you avoid duplicate compensation?",
      "Which effect would you prioritize first?",
    ],
    redFlags: ["Assumes every effect is reversible.", "Has no ledger.", "Retries without idempotency."],
    rubric: ["Uses idempotency.", "Keeps a ledger.", "Separates reversible from correctable.", "Tests compensation."],
  },
  {
    id: "window",
    question: "How do you shorten the unrecoverable window during a rollback?",
    difficulty: 2,
    hints: [
      "Detect sooner.",
      "Stop writes before the switch.",
      "Make the old version compatible.",
    ],
    answer:
      "I would shorten detection with a health and error gate, stop or drain new writes before switching artifacts, and make the new data backward compatible so the old code can read it. I would also pre-stage the rollback and test the switch. The goal is to minimize the time between the first bad effect and the point where the old version is safely serving.",
    followUps: [
      "What is the cost of draining writes?",
      "Which signal should trigger the rollback?",
      "How do you test the window before an incident?",
    ],
    redFlags: ["Waits for a human to notice.", "Keeps writes flowing during the switch.", "Ignores data compatibility."],
    rubric: ["Shortens detection.", "Drains writes.", "Ensures compatibility.", "Tests the switch."],
  },
  {
    id: "rollforward",
    question: "When is roll-forward safer than rollback after external effects have occurred?",
    difficulty: 3,
    hints: [
      "Rollback may be incompatible with new data.",
      "A tested fix can preserve the new data.",
      "The decision depends on reversibility and time.",
    ],
    answer:
      "Roll-forward is safer when the old code cannot read data the new version wrote, when the new data is already valuable, or when a tested fix can restore correctness faster than a reconciliation-heavy rollback. It is riskier when the cause is unknown or the fix is not tested. The decision should compare the time to a safe old state with the time to a verified new state, including compensation in both paths.",
    followUps: [
      "What would make roll-forward unsafe?",
      "How do you verify correctness after roll-forward?",
      "How does the error budget affect the choice?",
    ],
    redFlags: ["Chooses roll-forward by default.", "Ignores data compatibility.", "Has no verification."],
    rubric: ["Compares time to safe state.", "Considers data.", "Requires a tested fix.", "Plans verification."],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Inventory every database write, event, and external call the new version can make.",
      "Mark each effect reversible, correctable, or permanent.",
      "Add idempotency keys and a side-effect ledger.",
      "Test the compensation path in a sandbox.",
      "Confirm the old code can read data written by the new version.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop or drain new writes before restoring the old version.",
      "Record the rollback window and the effects produced in it.",
      "Restore the artifact and configuration.",
      "Run compensation and check provider ledgers for duplicates.",
    ],
  },
  {
    title: "After recovery",
    items: [
      "Reconcile every write and external effect from the window.",
      "Verify consumers have processed or corrected new-schema events.",
      "Document which effects could not be undone.",
      "Shorten the window and add missing compensation before the next release.",
    ],
  },
];

const references = [
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Rollback, release state, and the limits of restoring the previous artifact.",
  },
  {
    title: "Saga pattern",
    url: "https://microservices.io/patterns/data/saga.html",
    publisher: "microservices.io",
    kind: "docs" as const,
    note: "Compensating actions for distributed transactions and external effects.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rollback-data-loss": {
      model: rollbackDataLossModel,
      presets,
      instructions:
        "Start with Healthy, then apply Partial compensation. Apply No compensation to see data and external effects accumulate. Apply Drain first to isolate window length from compensation, then run the experiment and its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Write rates, effect counts, and windows are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-rollback-vs-rollforward", "deployment-automated-rollback", "deployment-schema-compat", "deployment-incident-deploy"],
};
