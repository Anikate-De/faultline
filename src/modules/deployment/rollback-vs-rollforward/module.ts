import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 9_000;

const params: ParamSpec[] = [
  {
    id: "decisionPath",
    label: "Mitigation path (0 rollback, 1 roll-forward)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Decision",
    help: "Zero restores the previous artifact. One keeps the new artifact and ships a fix. The model compares the residual error after each path.",
    format: "count",
  },
  {
    id: "newDataPercent",
    label: "Rows written in the new format",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Data",
    help: "Share of rows written by the new version since the release. Old code may not be able to read these rows.",
    format: "percent",
  },
  {
    id: "compatibilityPercent",
    label: "Old code compatibility with new rows",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Data",
    help: "Share of new-format rows the previous code can read correctly. Low compatibility makes rollback a data incident.",
    format: "percent",
  },
  {
    id: "fixReadinessPercent",
    label: "Fix readiness",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Fix",
    help: "How well the forward fix is understood, tested, and ready to deploy. Rolling forward with an untested fix adds a second change to the incident.",
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
  path: number;
  newData: number;
  compatibility: number;
  readiness: number;
  dataRisk: number;
  fixGap: number;
  residual: number;
  error: number;
  progress: number;
  p99: number;
}

function compute(p: Params, t: number): Values {
  const path = Math.round(clamp(num(p, "decisionPath", 0), 0, 1));
  const newData = clamp(num(p, "newDataPercent", 20), 0, 100);
  const compatibility = clamp(num(p, "compatibilityPercent", 90), 0, 100);
  const readiness = clamp(num(p, "fixReadinessPercent", 90), 0, 100);
  const dataRisk = path === 0 ? (newData * (100 - compatibility)) / 100 : 0;
  const rollbackResidual = 0.4 + dataRisk * 0.1;
  const forwardResidual = 0.4 + ((100 - readiness) / 100) * 7;
  const residual = path === 0 ? rollbackResidual : forwardResidual;
  const convergeSeconds = path === 0 ? 20 : 25;
  const progress = clamp(Math.max(0, t) / convergeSeconds);
  const initialError = 0.8;
  const error = initialError + (residual - initialError) * progress;
  const fixGap = path === 1 ? 100 - readiness : 0;
  const p99 = 90 + error * 30 + dataRisk * 0.8;

  return {
    path,
    newData,
    compatibility,
    readiness,
    dataRisk,
    fixGap,
    residual,
    error,
    progress,
    p99,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function errorHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function pathLabel(path: number): string {
  return path === 0 ? "Rollback" : "Roll-forward";
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const serviceHealth = errorHealth(values.error, 1, 3);
  const databaseHealth = errorHealth(values.dataRisk, 10, 30);
  const pathHealth: Health =
    values.path === 0
      ? errorHealth(values.dataRisk, 10, 30)
      : errorHealth(values.fixGap, 30, 60);
  const overall = worst(serviceHealth, databaseHealth, pathHealth);

  const stageNodes = [
    {
      id: "release",
      label: "Release v2",
      kind: "service" as const,
      health: serviceHealth,
      utilization: 0.7,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.error)} errors · ${pathLabel(values.path)} in progress`,
      detail: `The new version still serves ${TOTAL_RPS.toLocaleString()} rps while the team chooses a path. The modeled error rate is ${percent(values.error)} after ${Math.round(values.progress * 100)}% of the mitigation.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "database",
      label: "Shared database",
      kind: "db" as const,
      health: databaseHealth,
      utilization: 0.75,
      throughput: TOTAL_RPS,
      capacity: 12_000,
      sublabel: `${percent(values.newData)} new-format rows · incompatibility ${percent(values.dataRisk)}`,
      detail:
        values.path === 0
          ? "Rollback restores the old code, but the new-format rows remain. The old code may misread them, so the data risk survives the code switch."
          : "Roll-forward keeps the new code and the new data together. The data risk depends on whether the fix is correct, not on compatibility with old code.",
      meta: { stage: "full", view: "deployment" },
    },
    {
      id: "mitigation",
      label: pathLabel(values.path),
      kind: "service" as const,
      health: pathHealth,
      utilization: clamp(values.progress),
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel:
        values.path === 0
          ? `data risk ${percent(values.dataRisk)}`
          : `fix gap ${percent(values.fixGap)}`,
      detail:
        values.path === 0
          ? "A rollback is fast only when the previous artifact and the current data are compatible. New-format rows are the constraint."
          : "A roll-forward avoids the old-code compatibility problem, but only helps if the fix is understood and tested. An untested fix is a second release during an incident.",
      meta: { stage: "canary", view: "deployment" },
    },
  ];

  const flowNodes = [
    {
      id: "clients",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${TOTAL_RPS.toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "service-flow",
      label: "Checkout v2",
      kind: "service" as const,
      health: serviceHealth,
      utilization: 0.7,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `errors ${percent(values.error)}`,
      meta: { view: "flow" },
    },
    {
      id: "db-flow",
      label: "Database",
      kind: "db" as const,
      health: databaseHealth,
      utilization: 0.75,
      throughput: TOTAL_RPS,
      capacity: 12_000,
      sublabel: "new-format rows present",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service-flow", 1, overall),
      edge("service-db", "service-flow", "db-flow", 1, databaseHealth),
    ],
    metrics: [
      metric("service-error-rate", "Service error rate", values.error, "%", 1, 3, "percent"),
      metric("data-incompatibility", "Data incompatibility", values.dataRisk, "%", 10, 30, "percent"),
      metric("fix-gap", "Fix readiness gap", values.fixGap, "%", 30, 60, "percent"),
      metric("mitigation-progress", "Mitigation progress", values.progress * 100, "%", undefined, undefined, "percent"),
      metric("new-format-rows", "Rows in new format", values.newData, "%", undefined, undefined, "percent"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      path: values.path,
      progress: values.progress,
      dataRisk: values.dataRisk,
    },
    summary: `${pathLabel(values.path)} · ${percent(values.error)} errors · data incompatibility ${percent(values.dataRisk)} · fix gap ${percent(values.fixGap)}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 11)) / 2.8);
  const series: [string, number][] = [
    ["service-error-rate", values.error],
    ["data-incompatibility", values.dataRisk],
    ["fix-gap", values.fixGap],
    ["mitigation-progress", values.progress * 100],
    ["new-format-rows", values.newData],
    ["checkout-p99", values.p99],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "service-error-rate",
    metricId: "service-error-rate",
    warn: 1,
    crit: 3,
    title: "The chosen path is not restoring service",
    cause: "The residual error after the mitigation is still above the incident threshold. A rollback can preserve a data incompatibility, and a roll-forward can preserve an untested fix.",
    fix: "Stop and reassess the path. If rollback is selected and new-format rows are the problem, repair or reconcile the data before expecting recovery. If roll-forward is selected and the fix is not tested, stage the fix behind a flag and verify it before broad exposure.",
    checkFirst: [
      "Check the residual error against the pre-mitigation error, not only the current value.",
      "Check whether the selected path addressed code, data, or both.",
      "Check whether a second change is masking the first failure.",
    ],
  },
  {
    id: "data-incompatibility",
    metricId: "data-incompatibility",
    warn: 10,
    crit: 30,
    title: "Rollback would leave data the old code cannot read",
    cause: "The new version wrote rows in a new format. Restoring the previous artifact does not convert those rows, so the old code may misread, skip, or corrupt them.",
    fix: "Before rolling back, quantify the new-format rows and test the old code against a sample. Add a compatibility shim, dual-read path, or data repair. If none is safe, roll forward or restore to a point before the new writes.",
    checkFirst: [
      "Count rows written by the new version and inspect their shape.",
      "Test the previous artifact against a copy of those rows.",
      "Check whether a reversible migration or compatibility layer exists.",
    ],
  },
  {
    id: "fix-gap",
    metricId: "fix-gap",
    warn: 30,
    crit: 60,
    title: "The forward fix is not ready to ship",
    cause: "Roll-forward is faster only when the fix is understood and tested. With a large readiness gap, the team is adding a second unverified change during an active incident.",
    fix: "Do not roll forward on an untested fix. Reproduce the failure, write the smallest change, test it against the new data, and stage it behind a flag. If the fix cannot be ready, rollback or data repair may be the safer path.",
    checkFirst: [
      "Check whether the failure has a confirmed root cause and a failing test.",
      "Check whether the fix has been exercised against new-format data.",
      "Check whether the fix can be staged and reverted independently.",
    ],
  },
];

export const rollbackVsRollforwardModel: SimModel = {
  id: "deployment-rollback-vs-rollforward",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p, frame.t + dt);
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
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "checkout-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 60);
    const items: string[] = [];
    items.push(
      `The selected path is ${pathLabel(values.path)}. New-format rows are ${percent(values.newData)} of the table, and old-code compatibility is ${percent(values.compatibility)}.`,
    );
    if (values.path === 0) {
      items.push(
        `Rollback leaves ${percent(values.dataRisk)} of rows incompatible with the previous code. The code switch does not repair them.`,
      );
    } else {
      items.push(
        `Roll-forward avoids old-code compatibility, but the fix readiness gap is ${percent(values.fixGap)}. An untested fix is a second risk.`,
      );
    }
    items.push(
      `The residual service error is ${percent(values.residual)} after mitigation. The current error moves toward that value as the path completes.`,
    );
    items.push(
      `A rollback is safer when new-format rows are few or compatibility is high. A roll-forward is safer when the fix is understood and tested, not merely faster to type.`,
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
    description: "Few new-format rows and high old-code compatibility make rollback safe.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A rollback with moderate new-format data leaves a warning-level incompatibility.",
    tone: "warn",
    params: defaults({ newDataPercent: 40, compatibilityPercent: 70, fixReadinessPercent: 50 }),
  },
  {
    id: "failure",
    label: "Rollback into new data",
    description: "Most rows use the new format and the old code can read very few of them.",
    tone: "crit",
    params: defaults({ decisionPath: 0, newDataPercent: 80, compatibilityPercent: 20 }),
  },
  {
    id: "recovery",
    label: "Tested roll-forward",
    description: "The new format stays, and a fully tested fix removes the failure without a data rollback.",
    tone: "ok",
    params: defaults({ decisionPath: 1, newDataPercent: 80, compatibilityPercent: 20, fixReadinessPercent: 100 }),
  },
  {
    id: "forward-not-ready",
    label: "Untested roll-forward",
    description: "The team keeps the new code but ships an unready fix, leaving the incident open.",
    tone: "crit",
    params: defaults({ decisionPath: 1, newDataPercent: 80, compatibilityPercent: 20, fixReadinessPercent: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-rollback-data",
  title: "Predict whether rollback restores service",
  simId: "rollback-choice",
  question:
    "The new version wrote 80% of rows in a new format. The previous code can read only 20% of those rows. The team rolls back the artifact. What happens?",
  prediction: {
    options: [
      { id: "recovered", label: "Service recovers because the previous code is restored" },
      { id: "data", label: "Errors persist because the old code cannot read the new rows" },
      { id: "faster", label: "Rollback is always faster than roll-forward, so errors stop" },
      { id: "database", label: "The database automatically converts the new rows" },
    ],
    correctOptionId: "data",
    explanation:
      "Rollback restores code, not data. The new-format rows remain in the table, and the previous code can read only part of them. The residual error after rollback is driven by that incompatibility, so the code switch alone does not restore service.",
  },
  setup: defaults({ decisionPath: 0, newDataPercent: 80, compatibilityPercent: 20 }),
  runFor: 30,
  observe: [
    "Data incompatibility is 64%, above the critical threshold.",
    "Service error rate settles near 6.8%, above the incident threshold.",
    "Rollback progress reaches 100%, but the error does not fall to baseline.",
    "The old artifact is restored; the data written by the new version is not.",
  ],
  explain:
    "A rollback decision has to include the data written by the release. New-format rows, new enum values, new required fields, and external side effects can all survive the code switch. If the old code cannot read them, rollback makes the compatibility problem visible. The safe path may be roll-forward with a tested fix, a compatibility layer, or a data repair.",
  fix: defaults({ decisionPath: 1, newDataPercent: 80, compatibilityPercent: 20, fixReadinessPercent: 100 }),
  debrief:
    "The tested roll-forward keeps the new code and the new data together and removes the failure. The cost is that the fix had to be understood and verified during the incident, which is only possible if the work was prepared. Rollback remains the right default when new data is compatible or the new format can be reconciled. The decision should be made on residual risk, not on which action sounds faster.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Rollback restores the previous code artifact. Roll-forward keeps the new artifact and ships a fix. In a simple stateless service, rollback is usually the safer default because it returns to a known build. In a release that changed data, rollback only reverses half the change: the code returns, but the rows, messages, and external effects created by the new version remain.",
  },
  {
    type: "p",
    text: "The decision is a risk comparison, not a speed contest. Rollback risk comes from incompatibility between old code and new data. Roll-forward risk comes from an unverified fix and a second change during an incident. The right path is the one with the lower residual risk that the team can actually execute and verify.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The deployment controller can restore an artifact quickly if the previous image and configuration are available. The database and external systems do not roll back with it. New columns, new enum values, new required fields, queued messages, emails, and third-party charges can persist. The incident commander has to compare the code state with the data and side-effect state before choosing.",
  },
  {
    type: "compare",
    leftTitle: "Rollback",
    rightTitle: "Roll-forward",
    rows: [
      { label: "Code", left: "Returns to a known artifact", right: "Keeps the new artifact plus a fix" },
      { label: "Data", left: "New-format rows remain", right: "New format remains; fix must handle it" },
      { label: "Main risk", left: "Old code cannot read new data", right: "Fix is unverified or incomplete" },
      { label: "Best case", left: "Compatible data, fast recovery", right: "Root cause known, small tested fix" },
      { label: "Verification", left: "Old code against current rows", right: "Fix against current rows and load" },
    ],
  },
  {
    type: "p",
    text: "This model uses illustrative convergence times and error rates. The path completes over simulated seconds, not a claim about real recovery time. The data parameters are the important part: the share of rows written in the new format and the share the old code can read. Fix readiness is a judgment input, not a measured probability.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Service error rate as the selected path converges to its residual.",
      "Data incompatibility: the share of new-format rows the old code cannot read.",
      "Fix readiness gap: how much of the forward fix is still unproven.",
      "Mitigation progress and the share of rows already in the new format.",
      "A deployment view of the release, the shared database, and the selected path.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Rollback into new data and watch errors settle above the threshold even though the code rollback completes. Apply Tested roll-forward to see the same data with a safe path. Use Untested roll-forward to see why fixing forward without a tested fix is not automatically better.",
  },
  {
    type: "table",
    headers: ["Condition", "Favors rollback", "Favors roll-forward"],
    rows: [
      ["New-format rows", "Few, or old code reads them", "Many, and no compatibility layer"],
      ["Fix readiness", "Not understood or untested", "Root cause known and fix tested"],
      ["Schema change", "Additive and reversible", "Requires the new shape to function"],
      ["External effects", "None or reversible", "Already committed and need completion"],
      ["Time pressure", "Artifact is available and compatible", "Fix is small, staged, and verified"],
    ],
  },
  { type: "sim", simId: "rollback-choice" },
  { type: "experiment", experimentId: "predict-rollback-data" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The rollback preset restored the previous code, but 80% of rows were in the new format and the old code could read only 20% of them. Data incompatibility settled at 64%, and the service error rate settled near 6.8%. The rollback completed; the incident did not. The data written by the release outlived the code change.",
  },
  {
    type: "p",
    text: "The tested roll-forward kept the new code and the new data together. With the fix fully ready, the error fell to baseline. The untested roll-forward preset showed the opposite: the same path with a 20% ready fix left a large fix gap and a critical error. The path name did not determine the outcome; the data and fix readiness did.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment events: release start, error onset, rollback or fix deploy, recovery.",
      "Rows written by the new version, grouped by shape or schema version.",
      "Old-code read errors against new rows, including parse and constraint failures.",
      "Error budget burn and the residual error after the selected path.",
      "Fix evidence: failing test, root cause, staging result, and rollout plan.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check how many rows the new version wrote and whether the old code can read them. Check whether the forward fix has a confirmed root cause and a test. Check whether either path can be staged and reverted. Do not choose rollback only because the artifact is available.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop writes or isolate the affected path if the data state is still changing.",
      "Quantify new-format rows and test the old artifact against a sample.",
      "Choose rollback only if the old code can read the current data, or add a compatibility layer or repair.",
      "Choose roll-forward only with a confirmed cause, a tested fix, and a staged rollout.",
      "Verify the chosen path against the same user outcome that failed, then watch the error budget.",
      "Record the data and side effects the release created so the next rollback plan accounts for them.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Rollback is fast for code but may preserve an incompatible data shape.",
      "Roll-forward avoids old-code compatibility but adds a second change under pressure.",
      "Data repair can make rollback safe, but it takes time and must handle concurrent writes.",
      "A compatibility shim reduces rollback risk but adds code that must be maintained and later removed.",
      "Restoring from backup is a data rollback with a recovery point; it can lose writes that happened after the backup.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rollback-data",
    question:
      "A bad release is live and the database has new rows. The previous artifact is available. How do you decide between rollback and roll-forward?",
    difficulty: 3,
    hints: [
      "The artifact rollback does not reverse data.",
      "Count and inspect the rows the new version wrote.",
      "A tested fix is different from a fix that merely exists.",
    ],
    answer:
      "I would compare residual risk. For rollback, I need to know how many new-format rows exist and whether the old code can read them; if it cannot, rollback is a data incident. For roll-forward, I need a confirmed cause, a tested fix, and a way to stage it. I would also check external side effects that cannot be reversed. If neither path is clean, I would stop writes and use a compatibility layer or repair before choosing.",
    followUps: [
      "What would you do if the old code can read only half the new rows?",
      "How do external side effects change the decision?",
      "What evidence would make roll-forward acceptable during an incident?",
    ],
    redFlags: [
      "Rolls back because the artifact is available.",
      "Rolls forward because it sounds faster.",
      "Ignores data and external effects.",
    ],
    rubric: [
      "Quantifies new data.",
      "Tests old code against current rows.",
      "Requires fix evidence.",
      "Considers irreversible effects.",
    ],
  },
  {
    id: "fix-forward",
    question: "When is roll-forward the safer path, despite the risk of shipping another change?",
    difficulty: 3,
    hints: [
      "The root cause must be understood, not guessed.",
      "The fix should be small and independently revertible.",
      "The new data may make rollback impossible.",
    ],
    answer:
      "Roll-forward is safer when the root cause is confirmed, the fix is small and tested against the new data, and rollback would be incompatible with rows the new version already wrote. I would also want the fix staged behind a flag or a limited rollout so it can be stopped without another full deployment. If those conditions are missing, roll-forward is just a second unverified change.",
    followUps: [
      "How would you test the fix against production-shaped data?",
      "What makes a fix independently revertible?",
      "When would you use a flag instead of a deploy?",
    ],
    redFlags: [
      "Treats speed as the deciding factor.",
      "Ships an untested fix under pressure.",
      "Has no rollback plan for the fix itself.",
    ],
    rubric: [
      "Requires a confirmed cause.",
      "Requires a tested, small fix.",
      "Stages the rollout.",
      "Keeps a revert path.",
    ],
  },
  {
    id: "both-bad",
    question: "Neither rollback nor an immediate roll-forward is safe. What do you do?",
    difficulty: 4,
    hints: [
      "Reduce the rate of new damage first.",
      "Compatibility can be restored without a full code rollback.",
      "A restore has a recovery point, not a magic undo.",
    ],
    answer:
      "I would stop or slow writes to the affected path, preserve evidence, and choose a containment step that does not depend on either full path. That could be a compatibility shim that lets old code read new rows, a data repair, a read-only mode, or a restore to a point before the new writes. I would communicate the tradeoff and verify the containment against the user outcome before restoring normal traffic. The goal is to lower residual risk, not to pick a label.",
    followUps: [
      "How do you decide between a shim and a restore?",
      "What do you tell customers while writes are stopped?",
      "How do you prevent the same data trap next time?",
    ],
    redFlags: [
      "Picks a path without containment.",
      "Restores without checking the recovery point.",
      "Keeps writes flowing while the data shape is unknown.",
    ],
    rubric: [
      "Contains damage first.",
      "Considers shim, repair, and restore.",
      "Verifies the user outcome.",
      "Communicates the tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Decide which data changes are backward compatible and which are not.",
      "Keep the previous artifact and configuration available and tested.",
      "Define how new-format rows will be identified and counted.",
      "Write the rollback condition, including data compatibility checks.",
      "Prepare a staging path and test for a forward fix.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop or slow writes if the data state is still changing.",
      "Count new-format rows and test the old artifact against a sample.",
      "Check external effects that the release already committed.",
      "Require a confirmed cause and a tested fix before roll-forward.",
      "Verify recovery against the user outcome, not only the error graph.",
    ],
  },
  {
    title: "After recovery",
    items: [
      "Record which data and side effects the release created.",
      "Reconcile rows or messages that the chosen path left behind.",
      "Update the runbook with the compatibility test used in the decision.",
      "Add a failing test that reproduces the original defect.",
      "Review whether the release should have been expand/contract instead.",
    ],
  },
];

const references = [
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release and rollback mechanics, including the limits of restoring an artifact.",
  },
  {
    title: "Incident Response",
    url: "https://sre.google/workbook/incident-response/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident command, decision-making under pressure, and recovery verification.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Automated rollback, bake time, and the conditions that make a rollback safe.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rollback-choice": {
      model: rollbackVsRollforwardModel,
      presets,
      instructions:
        "Start with Healthy. Apply Rollback into new data and watch the error settle above the threshold despite a completed code rollback. Apply Tested roll-forward to compare the same data with a ready fix. Use Untested roll-forward to see the opposite risk.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Convergence times, row shares, and thresholds are teaching values, not incident data.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-automated-rollback",
    "deployment-rollback-data-loss",
    "deployment-blue-green-db-migration",
    "deployment-expand-contract",
  ],
};
