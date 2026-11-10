import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 9_000;

const params: ParamSpec[] = [
  {
    id: "migrationStep",
    label: "Migration step (0 legacy, 1 expand, 2 backfill, 3 dual-write, 4 contract)",
    min: 0,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "Sequence",
    help: "The step currently deployed. Each step must be safe to run while the previous release is still serving traffic.",
    format: "count",
  },
  {
    id: "backfillPercent",
    label: "Backfill coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data",
    help: "Share of existing rows copied from the old shape into the new shape before the new code reads it.",
    format: "percent",
  },
  {
    id: "dualWritePercent",
    label: "Dual-write coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data",
    help: "Share of new-code writes that also update the old shape so the previous release can still read them.",
    format: "percent",
  },
  {
    id: "oldCodeShare",
    label: "Traffic on previous release",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Rollout",
    help: "Share of traffic still served by the previous release once the new code is deployed.",
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
  step: number;
  backfill: number;
  dualWrite: number;
  oldShare: number;
  oldTraffic: number;
  newTraffic: number;
  oldError: number;
  newError: number;
  unpatched: number;
  rollbackBlocked: number;
  totalError: number;
  p99: number;
  newCodeLive: boolean;
}

function compute(p: Params): Values {
  const step = clamp(Math.round(num(p, "migrationStep", 2)), 0, 4);
  const backfill = clamp(num(p, "backfillPercent", 100), 0, 100);
  const dualWrite = clamp(num(p, "dualWritePercent", 100), 0, 100);
  const oldShare = clamp(num(p, "oldCodeShare", 20), 0, 100);
  const newCodeLive = step >= 3;
  const oldTraffic = TOTAL_RPS * (newCodeLive ? oldShare / 100 : 1);
  const newTraffic = TOTAL_RPS * (newCodeLive ? 1 - oldShare / 100 : 0);
  const backfillGap = 100 - backfill;
  const dualGap = 100 - dualWrite;
  const newShare = 1 - oldShare / 100;

  const newError =
    newTraffic > 0 ? 0.1 + backfillGap * (step === 4 ? 0.05 : 0.06) : 0;
  const oldError =
    oldTraffic === 0
      ? 0
      : step === 4
        ? 9
        : step === 3
          ? 0.1 + newShare * (dualGap / 100) * 8
          : 0.1;

  const unpatched = step === 0 ? 0 : backfillGap;
  const rollbackBlocked = step === 4 ? 100 : 0;
  const totalError =
    (oldTraffic / TOTAL_RPS) * oldError + (newTraffic / TOTAL_RPS) * newError;
  const p99 = 90 + totalError * 38 + unpatched * 1.2;

  return {
    step,
    backfill,
    dualWrite,
    oldShare,
    oldTraffic,
    newTraffic,
    oldError,
    newError,
    unpatched,
    rollbackBlocked,
    totalError,
    p99,
    newCodeLive,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function errorHealth(value: number): Health {
  if (value >= 3) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function patchHealth(value: number): Health {
  if (value >= 20) return "crit";
  if (value >= 5) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function stepLabel(step: number): string {
  if (step === 0) return "legacy schema";
  if (step === 1) return "expand applied";
  if (step === 2) return "backfill running";
  if (step === 3) return "dual-write live";
  return "contract applied";
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const oldHealth = values.oldTraffic > 0 ? errorHealth(values.oldError) : "ok";
  const newHealth = values.newTraffic > 0 ? errorHealth(values.newError) : "ok";
  const schemaHealth = worst(
    patchHealth(values.unpatched),
    values.rollbackBlocked >= 50 ? "crit" : "ok",
    errorHealth(values.totalError),
  );
  const stageNodes = [
    {
      id: "old-release",
      label: "Previous release",
      kind: "service" as const,
      health: oldHealth,
      utilization: clamp(values.oldTraffic / TOTAL_RPS),
      throughput: values.oldTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent((values.oldTraffic / TOTAL_RPS) * 100)} traffic · errors ${percent(values.oldError)}`,
      detail:
        values.oldTraffic > 0
          ? `The previous release serves ${Math.round(values.oldTraffic).toLocaleString()} rps against the old shape. Contract makes its queries fail.`
          : "The previous release has no traffic. It is still the rollback target until the old shape is removed.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "new-release",
      label: "New release",
      kind: "service" as const,
      health: newHealth,
      utilization: clamp(values.newTraffic / TOTAL_RPS),
      throughput: values.newTraffic,
      capacity: TOTAL_RPS,
      sublabel: values.newCodeLive
        ? `${percent((values.newTraffic / TOTAL_RPS) * 100)} traffic · errors ${percent(values.newError)}`
        : "not deployed",
      detail: values.newCodeLive
        ? `The new release reads the new shape. Backfill coverage is ${Math.round(values.backfill)}%, so unpatched rows become read failures.`
        : "The new code is not live yet. The expand and backfill steps can run while the old release continues to serve.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "schema",
      label: "Schema state",
      kind: "db" as const,
      health: schemaHealth,
      utilization: 0.75,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${stepLabel(values.step)} · unpatched ${percent(values.unpatched)}`,
      detail:
        values.step === 4
          ? "The old shape is removed. The data exists only in the new shape, so the previous release cannot read it and rollback cannot restore it."
          : "Both shapes exist. Backfill fills the new shape and dual writes keep the old shape current while the previous release drains.",
      meta: { stage: "full", view: "deployment" },
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
      id: "old-flow",
      label: "Previous release",
      kind: "service" as const,
      health: oldHealth,
      throughput: values.oldTraffic,
      capacity: TOTAL_RPS,
      sublabel: "old queries",
      meta: { view: "flow" },
    },
    {
      id: "new-flow",
      label: "New release",
      kind: "service" as const,
      health: newHealth,
      throughput: values.newTraffic,
      capacity: TOTAL_RPS,
      sublabel: "new queries",
      meta: { view: "flow" },
    },
    {
      id: "db-flow",
      label: "Shared schema",
      kind: "db" as const,
      health: schemaHealth,
      utilization: 0.75,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: "both shapes during transition",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-old", "clients", "old-flow", values.oldTraffic / TOTAL_RPS, oldHealth),
      edge("clients-new", "clients", "new-flow", values.newTraffic / TOTAL_RPS, newHealth),
      edge("old-db", "old-flow", "db-flow", values.oldTraffic / TOTAL_RPS, schemaHealth),
      edge("new-db", "new-flow", "db-flow", values.newTraffic / TOTAL_RPS, schemaHealth),
    ],
    metrics: [
      metric("old-code-error", "Old code error rate", values.oldError, "%", 1, 3, "percent"),
      metric("new-code-error", "New code error rate", values.newError, "%", 1, 3, "percent"),
      metric("unpatched-rows", "Unpatched rows", values.unpatched, "%", 5, 20, "percent"),
      metric("rollback-blocked", "Rollback blocked", values.rollbackBlocked, "%", 1, 50, "percent"),
      metric("service-error-rate", "Service error rate", values.totalError, "%", 1, 3, "percent"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), step: values.step },
    summary: `${stepLabel(values.step)} · old ${percent(values.oldError)} errors · new ${percent(values.newError)} errors · unpatched ${percent(values.unpatched)} · rollback ${values.rollbackBlocked >= 50 ? "blocked" : "available"}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 13)) / 2.4);
  const series: [string, number][] = [
    ["old-code-error", values.oldError],
    ["new-code-error", values.newError],
    ["unpatched-rows", values.unpatched],
    ["rollback-blocked", values.rollbackBlocked],
    ["service-error-rate", values.totalError],
    ["checkout-p99", values.p99],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "old-code-error",
    metricId: "old-code-error",
    warn: 1,
    crit: 3,
    title: "The previous release cannot read the new schema",
    cause: "The contract step ran before the previous release was drained. The old code still queries the old shape, but the migration removed or renamed it.",
    fix: "Stop the contract. Restore the old shape from the migration, or complete the cutover and treat the old release as unable to recover. Contract only after the old code share reaches zero.",
    checkFirst: [
      "Check whether the old shape still exists after the contract step.",
      "Check the traffic share on the previous release.",
      "Check the first old-code error against the migration timestamp.",
    ],
  },
  {
    id: "new-code-error",
    metricId: "new-code-error",
    warn: 1,
    crit: 3,
    title: "The new release reads rows the backfill never patched",
    cause: "The new code went live before backfill coverage was complete. Rows written by the old release or never copied still have a null or missing value in the new shape.",
    fix: "Pause promotion, keep the new shape nullable, finish the backfill, and verify null counts. Deploy the code that reads the new shape only after coverage is complete.",
    checkFirst: [
      "Check backfill progress and the null count on the new shape.",
      "Check whether the new code shipped before the backfill finished.",
      "Check whether old-release writes are captured after the backfill.",
    ],
  },
  {
    id: "unpatched-rows",
    metricId: "unpatched-rows",
    warn: 5,
    crit: 20,
    title: "Rows remain only in the old shape",
    cause: "The backfill lagged live writes, was throttled, or failed partway through. The new shape is incomplete, so any reader that depends on it sees missing data.",
    fix: "Resume the backfill in bounded batches, track progress by key range, and reconcile counts and checksums. Keep dual writes on until coverage is stable across a full traffic cycle.",
    checkFirst: [
      "Check the backfill checkpoint and the oldest unpatched key.",
      "Check whether live writes outpace the backfill.",
      "Check for failed batches or rows skipped by the query.",
    ],
  },
  {
    id: "rollback-blocked",
    metricId: "rollback-blocked",
    warn: 1,
    crit: 50,
    title: "The contract step removed the rollback path",
    cause: "The old shape is gone, so restoring the previous artifact leaves it querying a schema that no longer exists. Rows written in the new shape may also be unreadable by old code.",
    fix: "Treat contract as a one-way door. Require zero old-code traffic, a verified restore, and a data-repair plan before running it. Otherwise keep the old shape for one more release.",
    checkFirst: [
      "Check whether the migration drops or renames anything the old code reads.",
      "Check the drain evidence, including jobs and consumers.",
      "Check whether a restore has been tested with current data.",
    ],
  },
];

export const expandContractModel: SimModel = {
  id: "deployment-expand-contract",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
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
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "checkout-p99" ? { ...item, value: Math.max(0, item.value + jitter * 2) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Migration step ${values.step} is ${stepLabel(values.step)}. The previous release still serves ${percent((values.oldTraffic / TOTAL_RPS) * 100)} of traffic.`,
    );
    if (values.unpatched > 0) {
      items.push(
        `${percent(values.unpatched)} of rows are not in the new shape. Backfill must catch up before new readers depend on it.`,
      );
    } else {
      items.push("Backfill coverage is complete; every existing row has a value in the new shape.");
    }
    items.push(
      `Old-code errors are ${percent(values.oldError)} and new-code errors are ${percent(values.newError)}. Service error rate is ${percent(values.totalError)}.`,
    );
    items.push(
      values.step === 4
        ? "The contract step removed the old shape. Rollback is blocked even if no old traffic is left."
        : "Both shapes still exist, so a code rollback remains possible while the old release is draining.",
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
    description: "Expand and backfill are complete before the new code reads the new shape.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The new code is live, dual-write coverage lags, and the previous release sees errors.",
    tone: "warn",
    params: defaults({ migrationStep: 3, backfillPercent: 95, dualWritePercent: 70, oldCodeShare: 35 }),
  },
  {
    id: "failure",
    label: "Contract early",
    description: "The contract step runs while 60% of traffic still uses the previous release.",
    tone: "crit",
    params: defaults({ migrationStep: 4, oldCodeShare: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Backfill and dual writes are complete, and the contract has not run.",
    tone: "ok",
    params: defaults({ migrationStep: 3, oldCodeShare: 40 }),
  },
  {
    id: "backfill-gap",
    label: "Backfill gap",
    description: "The new code is live while 60% of rows remain only in the old shape.",
    tone: "crit",
    params: defaults({ migrationStep: 3, backfillPercent: 40, oldCodeShare: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-contract-break",
  title: "Predict what the contract step breaks",
  simId: "expand-contract",
  question:
    "The new code is live and 60% of traffic still runs the previous release. The team runs the contract step to finish the rename. What fails first?",
  prediction: {
    options: [
      { id: "old", label: "The previous release fails because its column is gone" },
      { id: "new", label: "The new release fails because the new column is missing" },
      { id: "none", label: "Nothing; the rename is backward compatible" },
      { id: "backfill", label: "Only the backfill job fails" },
    ],
    correctOptionId: "old",
    explanation:
      "Contract removes the shape the previous release still queries. The new release is fine because it uses the new shape. A code rollback cannot recreate the dropped column, so the old version fails as soon as it serves a request.",
  },
  setup: defaults({ migrationStep: 4, oldCodeShare: 60 }),
  runFor: 20,
  observe: [
    "Old-code error rate is 9%; new-code error rate stays near 0.1%.",
    "Rollback blocked is 100% because the old shape is removed.",
    "Unpatched rows are 0%: the backfill completed, but compatibility still failed.",
    "The weighted service error rate is above 5% because most traffic still hits the old release.",
  ],
  explain:
    "Each expand/contract step is independently deployable, but not independently reversible. Expand and backfill preserve both shapes. Contract is the one-way step. It is safe only after the old code is drained, and even then it removes the fast code rollback. The traffic share on the previous release is the signal that the drain is incomplete.",
  fix: defaults({ migrationStep: 3, oldCodeShare: 40 }),
  debrief:
    "The fixed step keeps both shapes and both versions compatible. The cost is a longer transition, more storage, and dual writes that must stay correct. The benefit is that either version can serve while the backfill catches up. Contract belongs in a later release, after the old code share reaches zero and the rollback plan accounts for the data.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Expand/contract is a way to change a database shape while old and new code run at the same time. The expand step adds the new shape without removing the old one. A backfill copies existing rows. Dual writes keep both shapes current while both versions serve. The contract step removes the old shape only after the old code is gone.",
  },
  {
    type: "p",
    text: "The point is not to avoid a rename. The point is to make every intermediate state deployable. If a column rename happens in one migration, the previous release breaks the moment the migration runs. If it happens in four steps, each release can be deployed, observed, and rolled back without requiring both code and data to reverse at once.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application deployment pipeline ships code. The migration pipeline changes the schema. They meet at the database, where the previous release, the new release, background jobs, and consumers may all read or write the same rows. Expand/contract puts the compatibility work in the schema and the dual-write path so neither pipeline has to be perfectly synchronized.",
  },
  {
    type: "compare",
    leftTitle: "One-step migration",
    rightTitle: "Expand/contract",
    rows: [
      { label: "Schema state", left: "Old shape disappears at once", right: "Both shapes coexist during transition" },
      { label: "Old code", left: "Breaks on the next query", right: "Keeps reading the old shape" },
      { label: "New code", left: "Starts against the new shape", right: "Tolerates old rows until backfill completes" },
      { label: "Rollback", left: "Code and data must reverse together", right: "Each step can be paused or reversed" },
    ],
  },
  {
    type: "table",
    headers: ["Step", "What changes", "What must remain true"],
    rows: [
      ["Expand", "Add nullable column or table", "Old code ignores it; new code tolerates null"],
      ["Backfill", "Copy old rows into the new shape", "Old shape still serves reads and writes"],
      ["Dual write", "New code updates both shapes", "Old readers see current values"],
      ["Contract", "Remove the old shape", "No old code or consumer remains"],
    ],
  },
  {
    type: "p",
    text: "The model uses an illustrative service rate and error thresholds. It shows the sequence, not a production sizing rule. The previous release keeps serving until its traffic share is zero, and the new release can only be healthy if the backfill and dual writes have covered the rows it reads.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Old-code and new-code error rates, separated by version.",
      "Unpatched rows: the share of data that exists only in the old shape.",
      "Rollback blocked: whether a previous artifact could still read the schema.",
      "Service error rate and checkout p99 as the user-facing result.",
      "A schema-state node that names the current expand/contract step.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Contract early. Watch old-code errors rise while the new release stays healthy. Switch to Backfill gap to see the opposite failure: the new release reads rows the backfill never reached. Use the experiment to test whether contract can be undone by deploying old code.",
  },
  {
    type: "p",
    text: "A safe sequence is boring on purpose. Expand, wait for the schema change to be visible everywhere, backfill until coverage is stable, dual-write until the old code is drained, then contract in a later release. The tradeoff is time and temporary write amplification. The alternative is a migration that makes rollback impossible at the moment you need it.",
  },
  { type: "sim", simId: "expand-contract" },
  { type: "experiment", experimentId: "predict-contract-break" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In this model, the contract step removed the old shape while 60% of traffic still ran the previous release. The new release stayed near 0.1% errors, but the old release returned 9%. The weighted service error rate was above 5%. Rolling back the artifact could not restore the dropped column, so the code rollback made the data problem visible rather than fixing it.",
  },
  {
    type: "p",
    text: "The backfill-gap preset shows the other half. The new code was live before the backfill finished, so new readers hit null values while the old release stayed healthy. Expand/contract has to protect both directions: old readers need the old shape to stay current, and new readers need the new shape to be complete.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-version error rate, request count, and latency during each migration step.",
      "Backfill progress, null counts, and reconciliation between old and new shapes.",
      "Dual-write error rate and lag, not only write volume.",
      "Schema migration events correlated with errors from either version.",
      "Traffic share on the previous release, including jobs and consumers outside the request path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the migration step against the traffic still on the previous release. Check whether the new code went live before the backfill finished. Check dual-write coverage and unpatched rows before concluding that the new release is at fault.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop at the current step; do not run contract to fix an error caused by contract.",
      "Restore the old shape if it was removed, or finish the transition if restore is not possible.",
      "Finish the backfill in batches and reconcile counts and checksums.",
      "Keep dual writes at full coverage until the old release has no traffic.",
      "Drain request traffic, jobs, and consumers; observe a full traffic cycle.",
      "Run contract as a separate reviewed change with a tested restore plan.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More steps mean more deployments, but each step has a small blast radius.",
      "Dual writes add latency and write cost while both shapes are maintained.",
      "A slow backfill is gentler on the database but leaves a longer compatibility window.",
      "Contract simplifies the schema and removes dead code, but ends the fast rollback path.",
      "Keeping the old shape for a retention period costs storage but preserves read compatibility.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rename-sequence",
    question: "Walk me through renaming a column that both the old and new releases use.",
    difficulty: 3,
    hints: [
      "Do not rename in place while both versions run.",
      "The old name must stay readable until the old code is drained.",
      "Each step needs its own deploy and observation window.",
    ],
    answer:
      "I would add the new column as nullable, deploy code that writes both columns and can read either, backfill the new column from the old one, verify coverage, then switch reads to the new column. Once the old release has no traffic and no consumers, I would stop writing the old column and drop it in a later migration. Each step is independently deployable. The rename becomes a sequence of compatible states rather than one destructive migration.",
    followUps: [
      "When would you switch reads before dropping the old column?",
      "How do you handle indexes and constraints on the new column?",
      "What would make you pause between steps?",
    ],
    redFlags: [
      "Renames the column in one migration.",
      "Drops the old column while old code is live.",
      "Backfills without handling new writes.",
    ],
    rubric: [
      "Uses expand, backfill, dual-write, contract.",
      "Keeps both shapes readable during transition.",
      "Checks drain before contract.",
      "Makes each step deployable.",
    ],
  },
  {
    id: "backfill-lag",
    question: "The backfill is at 95% but live writes keep arriving. How do you know when it is complete?",
    difficulty: 3,
    hints: [
      "A percentage can hide a moving target.",
      "Track the oldest unpatched key and the write rate.",
      "A stable coverage plateau is not the same as completeness.",
    ],
    answer:
      "I would track the backfill checkpoint, the oldest unpatched key, and the rate of new rows that need patching. Completion means the backfill has caught up to the live write boundary and stays caught up, not just that a percentage looks high. I would verify counts and checksums, watch null counts on the new shape, and keep dual writes on so new rows are covered even after the historical backfill ends.",
    followUps: [
      "How would you backfill without a long table lock?",
      "What do you do with rows that fail validation?",
      "How do you reconcile deletes and updates during backfill?",
    ],
    redFlags: [
      "Trusts a single percentage.",
      "Stops dual writes when historical backfill ends.",
      "Does not reconcile counts.",
    ],
    rubric: [
      "Tracks a moving write boundary.",
      "Verifies counts and checksums.",
      "Keeps live writes covered.",
      "Handles updates and deletes.",
    ],
  },
  {
    id: "contract-decision",
    question: "What signals prove the old code is drained enough to run contract?",
    difficulty: 4,
    hints: [
      "Request traffic is not the only consumer.",
      "Background jobs and exports can hold the old shape.",
      "The contract step is hard to reverse.",
    ],
    answer:
      "I would require zero production traffic on the previous release, no background jobs, consumers, exports, or analytics queries using the old shape, complete backfill with reconciliation, clean dual writes, and a tested restore or data-repair plan. I would also want the new release to survive a full traffic cycle. Contract is a one-way door, so the evidence has to cover every reader, not just the request path.",
    followUps: [
      "How do you discover unknown consumers of a column?",
      "What is the rollback plan after contract?",
      "How long would you keep the old shape if storage is cheap?",
    ],
    redFlags: [
      "Only checks HTTP traffic.",
      "Contracts without a restore test.",
      "Treats contract as reversible because the artifact exists.",
    ],
    rubric: [
      "Covers request and non-request consumers.",
      "Requires backfill and dual-write evidence.",
      "Requires a tested recovery plan.",
      "Acknowledges the one-way door.",
    ],
  },
];

const checklist = [
  {
    title: "Design the sequence",
    items: [
      "List every reader and writer of the column, including jobs, exports, and analytics.",
      "Choose an expand shape that old code can ignore and new code can tolerate as null.",
      "Decide where reads switch and where writes switch; do not do both blindly.",
      "Define backfill batching, throttling, and reconciliation queries.",
      "Write the drain condition and the contract criteria before starting.",
    ],
  },
  {
    title: "Run the transition",
    items: [
      "Deploy expand before any code that needs the new shape.",
      "Backfill while live writes continue, and track the moving write boundary.",
      "Keep dual writes at full coverage until the old release is drained.",
      "Compare old-code and new-code errors separately at every step.",
      "Pause if unpatched rows grow or dual-write errors rise.",
    ],
  },
  {
    title: "Contract safely",
    items: [
      "Confirm no traffic, job, or consumer still uses the old shape.",
      "Verify counts and checksums across both shapes.",
      "Test restore or data repair with current data volume.",
      "Record contract as a one-way door with an explicit owner.",
      "Keep the previous artifact for application-only rollback if the shape still supports it.",
    ],
  },
];

const references = [
  {
    title: "Parallel Change",
    url: "https://martinfowler.com/bliki/ParallelChange.html",
    publisher: "Martin Fowler",
    kind: "docs" as const,
    note: "The expand, migrate, contract sequence and its compatibility rules.",
  },
  {
    title: "ALTER TABLE",
    url: "https://www.postgresql.org/docs/current/sql-altertable.html",
    publisher: "PostgreSQL Documentation",
    kind: "docs" as const,
    note: "Additive and destructive schema operations, defaults, and locking behavior.",
  },
  {
    title: "AWS Database Migration Service",
    url: "https://docs.aws.amazon.com/dms/latest/userguide/Welcome.html",
    publisher: "AWS Documentation",
    kind: "docs" as const,
    note: "Migration concepts and ongoing replication for schema and data changes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "expand-contract": {
      model: expandContractModel,
      presets,
      instructions:
        "Start with Healthy, then apply Contract early and watch the old-code error rate. Switch to Backfill gap to see the new release fail instead. Use the experiment to test whether contract can be undone by redeploying old code.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Request rates, error rates, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-blue-green-db-migration",
    "deployment-blue-green",
    "deployment-schema-compat",
    "deployment-rollback-data-loss",
  ],
};
