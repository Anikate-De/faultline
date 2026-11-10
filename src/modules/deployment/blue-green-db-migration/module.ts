import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 10_000;

const params: ParamSpec[] = [
  {
    id: "cutoverPercent",
    label: "Traffic on green",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Cutover",
    help: "Share of traffic served by the new version. The rest still runs the previous version against the same database.",
    format: "percent",
  },
  {
    id: "migrationPhase",
    label: "Schema phase (0 code only, 1 expand, 2 backfill, 3 contract)",
    min: 0,
    max: 3,
    step: 1,
    value: 2,
    unit: "",
    group: "Schema",
    help: "Zero deploys new code before its column exists. One adds a nullable shape. Two backfills and dual-writes. Three drops or renames the old shape.",
    format: "count",
  },
  {
    id: "dualWritePercent",
    label: "Dual-write coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Compatibility",
    help: "Share of new-version writes that also update the old shape so the previous version can still read them.",
    format: "percent",
  },
  {
    id: "backfillPercent",
    label: "Backfill coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Compatibility",
    help: "Share of existing rows copied into the new shape. New readers can fail on rows that were never backfilled.",
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
  cutover: number;
  phase: number;
  dualWrite: number;
  backfill: number;
  oldTraffic: number;
  newTraffic: number;
  oldError: number;
  newError: number;
  divergence: number;
  rollbackBlocked: number;
  totalError: number;
  p99: number;
}

function compute(p: Params): Values {
  const cutover = clamp(num(p, "cutoverPercent", 60) / 100);
  const phase = clamp(Math.round(num(p, "migrationPhase", 2)), 0, 3);
  const dualWrite = clamp(num(p, "dualWritePercent", 100), 0, 100);
  const backfill = clamp(num(p, "backfillPercent", 100), 0, 100);
  const oldTraffic = TOTAL_RPS * (1 - cutover);
  const newTraffic = TOTAL_RPS * cutover;
  const backfillGap = 100 - backfill;
  const dualGap = 100 - dualWrite;

  let newError = 0;
  if (newTraffic > 0) {
    if (phase === 0) {
      newError = 9;
    } else if (phase === 3) {
      newError = 0.1 + backfillGap * 0.05;
    } else {
      newError = 0.1 + backfillGap * 0.05 + (1 - cutover) * 0.8;
    }
  }

  let oldError = 0;
  if (oldTraffic > 0) {
    oldError =
      phase === 3
        ? 9
        : 0.1 + dualGap * 0.05 * cutover;
  }

  const divergence = clamp(backfillGap + dualGap * cutover * 0.5, 0, 100);
  const rollbackBlocked = phase === 3 ? 100 : 0;
  const totalError = cutover * newError + (1 - cutover) * oldError;
  const p99 = 90 + totalError * 35 + divergence * 1.1;

  return {
    cutover,
    phase,
    dualWrite,
    backfill,
    oldTraffic,
    newTraffic,
    oldError,
    newError,
    divergence,
    rollbackBlocked,
    totalError,
    p99,
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

function gapHealth(value: number): Health {
  if (value >= 20) return "crit";
  if (value >= 5) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function phaseLabel(phase: number): string {
  if (phase === 0) return "new code, no schema";
  if (phase === 1) return "expand, nullable shape";
  if (phase === 2) return "backfill and dual-write";
  return "contract, old shape removed";
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const oldHealth = values.oldTraffic > 0 ? errorHealth(values.oldError) : "ok";
  const newHealth = values.newTraffic > 0 ? errorHealth(values.newError) : "ok";
  const dbHealth = worst(
    gapHealth(values.divergence),
    values.rollbackBlocked >= 50 ? "crit" : values.rollbackBlocked >= 1 ? "warn" : "ok",
    errorHealth(values.totalError),
  );
  const stageNodes = [
    {
      id: "blue",
      label: "Blue v1",
      kind: "service" as const,
      health: oldHealth,
      utilization: clamp(values.oldTraffic / TOTAL_RPS),
      throughput: values.oldTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent((1 - values.cutover) * 100)} traffic · errors ${percent(values.oldError)}`,
      detail:
        values.oldTraffic > 0
          ? `The previous version still serves ${Math.round(values.oldTraffic).toLocaleString()} rps. Its error rate is ${percent(values.oldError)} against the shared schema.`
          : "The previous version serves no production traffic. It is still the rollback target only if the database still has its shape.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "green",
      label: "Green v2",
      kind: "service" as const,
      health: newHealth,
      utilization: clamp(values.newTraffic / TOTAL_RPS),
      throughput: values.newTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.cutover * 100)} traffic · errors ${percent(values.newError)}`,
      detail: `The new version serves ${Math.round(values.newTraffic).toLocaleString()} rps. Its error rate is ${percent(values.newError)}. Backfill coverage is ${Math.round(values.backfill)}%.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "schema",
      label: "Shared database",
      kind: "db" as const,
      health: dbHealth,
      utilization: 0.8,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${phaseLabel(values.phase)} · divergence ${percent(values.divergence)}`,
      detail:
        values.phase === 3
          ? "The old shape is gone. Rolling code back does not restore the dropped column or the data that used it, so the rollback path is blocked."
          : "Both versions read and write the same database. The new shape is additive, and dual writes keep the old shape valid until the old code is drained.",
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
      id: "blue-flow",
      label: "Blue v1",
      kind: "service" as const,
      health: oldHealth,
      throughput: values.oldTraffic,
      capacity: TOTAL_RPS,
      sublabel: "previous release",
      meta: { view: "flow" },
    },
    {
      id: "green-flow",
      label: "Green v2",
      kind: "service" as const,
      health: newHealth,
      throughput: values.newTraffic,
      capacity: TOTAL_RPS,
      sublabel: "new release",
      meta: { view: "flow" },
    },
    {
      id: "db-flow",
      label: "Shared database",
      kind: "db" as const,
      health: dbHealth,
      utilization: 0.8,
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: "one schema, two versions",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-blue", "clients", "blue-flow", 1 - values.cutover, oldHealth),
      edge("clients-green", "clients", "green-flow", values.cutover, newHealth),
      edge("blue-db", "blue-flow", "db-flow", 1 - values.cutover, dbHealth),
      edge("green-db", "green-flow", "db-flow", values.cutover, dbHealth),
    ],
    metrics: [
      metric("old-version-error", "Old version error rate", values.oldError, "%", 1, 3, "percent"),
      metric("new-version-error", "New version error rate", values.newError, "%", 1, 3, "percent"),
      metric("row-divergence", "Rows missing new shape", values.divergence, "%", 5, 20, "percent"),
      metric("rollback-blocked", "Rollback blocked", values.rollbackBlocked, "%", 1, 50, "percent"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 300, 800, "ms"),
      metric("service-error-rate", "Service error rate", values.totalError, "%", 1, 3, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), phase: values.phase, cutover: values.cutover },
    summary: `${phaseLabel(values.phase)} · blue ${percent((1 - values.cutover) * 100)} at ${percent(values.oldError)} errors · green ${percent(values.cutover * 100)} at ${percent(values.newError)} errors · rollback ${values.rollbackBlocked >= 50 ? "blocked" : "available"}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 11)) / 2.7);
  const series: [string, number][] = [
    ["old-version-error", values.oldError],
    ["new-version-error", values.newError],
    ["row-divergence", values.divergence],
    ["rollback-blocked", values.rollbackBlocked],
    ["checkout-p99", values.p99],
    ["service-error-rate", values.totalError],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "old-version-error",
    metricId: "old-version-error",
    warn: 1,
    crit: 3,
    title: "The previous version can no longer read the schema",
    cause: "The contract step removed or renamed a shape that the previous release still queries. Rolling traffic back does not repair the data, so the old version fails as soon as it serves requests.",
    fix: "Stop the contract step. Restore the old shape from the migration, or finish the cutover and accept that rollback is no longer available. In the next release, run contract only after the old code is fully drained.",
    checkFirst: [
      "Check whether the old column or table still exists after the migration.",
      "Compare old-version errors with the exact timestamp of the contract step.",
      "Check whether any traffic still reaches the previous release.",
    ],
  },
  {
    id: "new-version-error",
    metricId: "new-version-error",
    warn: 1,
    crit: 3,
    title: "The new version is reading rows the backfill never reached",
    cause: "The new code queries a shape that is still null or missing for part of the table. Deploying new code before the expand or backfill has completed moves the failure into production.",
    fix: "Pause promotion, finish the backfill, and keep the new column nullable until coverage is complete. Deploy the expand before the code that needs it, not after.",
    checkFirst: [
      "Check backfill coverage and the count of rows with a null new value.",
      "Check whether the new code shipped before the expand migration finished.",
      "Check whether old-version writes populate the new shape.",
    ],
  },
  {
    id: "row-divergence",
    metricId: "row-divergence",
    warn: 5,
    crit: 20,
    title: "The two shapes have diverged",
    cause: "Incomplete backfill or incomplete dual writes leave rows that exist in one shape but not the other. A rollback or a read from the other version returns stale or missing data.",
    fix: "Finish the backfill in batches, verify counts and checksums, and keep dual writes at full coverage until the old version is drained. Do not contract while divergence is above the agreed limit.",
    checkFirst: [
      "Compare row counts and checksums between old and new shapes.",
      "Check the dual-write error rate, not only the write volume.",
      "Check whether the backfill runs behind live writes.",
    ],
  },
  {
    id: "rollback-blocked",
    metricId: "rollback-blocked",
    warn: 1,
    crit: 50,
    title: "Rollback is no longer a valid recovery path",
    cause: "A destructive migration ran while the previous version was still part of the deployment. The code artifact still exists, but the database no longer matches it.",
    fix: "Treat the contract step as a one-way door. Require the old version to be drained, a verified backup, and a tested restore before running it. Otherwise keep the old shape until the next release.",
    checkFirst: [
      "Check whether the migration drops, renames, or narrows a column the old code uses.",
      "Check the traffic share still on the previous release.",
      "Check whether a restore has been tested against the new data, not only the old backup.",
    ],
  },
];

export const blueGreenDbMigrationModel: SimModel = {
  id: "deployment-blue-green-db-migration",
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
    if (values.phase === 3) {
      items.push(
        `The contract step removed the old shape while ${percent((1 - values.cutover) * 100)} of traffic still runs the previous version. That makes rollback a data problem, not a code problem.`,
      );
    } else {
      items.push(
        `The old shape is still present. Backfill is ${Math.round(values.backfill)}% and dual-write coverage is ${Math.round(values.dualWrite)}%, so both versions can share the database.`,
      );
    }
    items.push(
      `The previous version returns ${percent(values.oldError)} errors and the new version returns ${percent(values.newError)}. Weighted service error rate is ${percent(values.totalError)}.`,
    );
    items.push(
      `Rows missing the new shape are ${percent(values.divergence)}. A rollback restores the code artifact, not those rows.`,
    );
    items.push(
      `Rollback is ${values.rollbackBlocked >= 50 ? "blocked" : "available"} in this model. The cutover percentage does not change schema compatibility.`,
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
    description: "Additive schema, complete backfill, full dual writes, and a partial cutover.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Most traffic is on the new version and dual writes lag, so both versions see some errors.",
    tone: "warn",
    params: defaults({ cutoverPercent: 80, dualWritePercent: 85, backfillPercent: 90 }),
  },
  {
    id: "failure",
    label: "Contract early",
    description: "The old column is dropped while 40% of traffic still runs the previous version.",
    tone: "crit",
    params: defaults({ cutoverPercent: 40, migrationPhase: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The contract waits until the cutover is complete and the backfill has caught up.",
    tone: "ok",
    params: defaults({ cutoverPercent: 100, migrationPhase: 2 }),
  },
  {
    id: "contract-after-drain",
    label: "Contract after drain",
    description: "No old traffic remains, but the dropped shape still makes rollback impossible.",
    tone: "crit",
    params: defaults({ cutoverPercent: 100, migrationPhase: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-contract-rollback",
  title: "Predict what breaks when contract runs early",
  simId: "blue-green-migration",
  question:
    "The expand and backfill are complete. The contract step drops the old column while 40% of traffic still runs the previous release. What happens when you need to roll back?",
  prediction: {
    options: [
      { id: "new-code", label: "The new version fails because its column is missing" },
      { id: "old-code", label: "The previous version fails because the old shape is gone, and the data is not restored" },
      { id: "nothing", label: "Nothing; the code artifact is enough to roll back" },
      { id: "cache", label: "Only the cache needs to be warmed" },
    ],
    correctOptionId: "old-code",
    explanation:
      "Rollback swaps the code, not the schema. Once the old column is dropped, the previous release queries a shape that no longer exists. Rows written by the new version also use the new shape, so restoring code alone cannot reconstruct them.",
  },
  setup: defaults({ cutoverPercent: 40, migrationPhase: 3 }),
  runFor: 20,
  observe: [
    "Old-version error rate is 9% while the new version stays near 0.6%.",
    "Rollback blocked is 100% because the old shape is gone.",
    "Row divergence is 0%: the backfill completed, but compatibility still failed.",
    "Rolling traffic back to the previous version increases errors instead of recovering service.",
  ],
  explain:
    "The cutover percentage controls traffic, not schema compatibility. Both versions share one database until the old code is drained. A destructive step is safe only after that drain, and even then it removes the rollback path. Expand, backfill, and dual-write keep the old shape valid while both versions serve.",
  fix: defaults({ cutoverPercent: 100, migrationPhase: 2 }),
  debrief:
    "The fixed sequence drains the old version before any destructive step. The cost is time and temporary dual writes, plus the discipline to keep the old shape longer than the new code needs it. The contract step remains a one-way door: if it runs, the next rollback plan must include data repair or restore, not only a code deploy.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A blue-green deployment runs two application environments and switches traffic between them. The switch is fast because both environments are already running. The database is the part that does not switch. During the cutover, blue and green use the same schema, often at the same time, so a change that only the new code understands can break the old code before the rollout finishes.",
  },
  {
    type: "p",
    text: "A blue-green database migration therefore has to be backward compatible: the old version must still read and write the schema while the new version is live. The safe pattern is expand, migrate, then contract. Add the new shape first, keep both shapes valid, move reads and writes over, and remove the old shape only after the old code is drained. Rollback restores code. It does not restore a dropped column or rows written only in the new shape.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The load balancer or service mesh decides which environment receives traffic. The database sits below both environments and is shared. A deployment pipeline may treat the application cutover and the schema migration as separate events, but users see one system: a request from either version can touch the same rows.",
  },
  {
    type: "compare",
    leftTitle: "Compatible change",
    rightTitle: "Destructive change",
    rows: [
      { label: "Schema", left: "Add a nullable column or table", right: "Drop, rename, or narrow a column in use" },
      { label: "Old code", left: "Ignores the new shape and still works", right: "Queries a shape that no longer exists" },
      { label: "New code", left: "Writes the new shape and tolerates old rows", right: "Works, but the old data may be unrecoverable" },
      { label: "Rollback", left: "Switch traffic back; both versions still fit", right: "Code switches back, data does not" },
    ],
  },
  {
    type: "p",
    text: "This module models a service that sends a share of traffic to green while a migration phase controls the schema. Dual-write coverage protects the old shape when new code writes. Backfill coverage protects new readers from rows that were never copied. The thresholds and capacities are illustrative teaching values, not provider limits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Blue and green error rates, separated so a blended service rate cannot hide one broken version.",
      "Rows missing the new shape, which shows backfill and dual-write gaps.",
      "Rollback blocked, which turns critical when the old shape is removed.",
      "Checkout p99 and the weighted service error rate.",
      "A deployment view of both environments and the shared database.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Contract early. Watch the old-version error rate rise while the new version stays healthy. Move the schema phase back to backfill and the errors clear. Use the experiment to predict what a code rollback can and cannot repair.",
  },
  {
    type: "table",
    headers: ["Phase", "Change", "Both versions compatible"],
    rows: [
      ["Expand", "Add a nullable column or table", "Yes, if old code ignores it"],
      ["Backfill", "Copy old rows into the new shape", "Yes, while the old shape remains"],
      ["Dual write", "New code updates both shapes", "Yes, if coverage stays complete"],
      ["Contract", "Remove the old shape", "No; old code and rollback break"],
    ],
  },
  { type: "sim", simId: "blue-green-migration" },
  { type: "experiment", experimentId: "predict-contract-rollback" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In this model, the contract step dropped the old shape while the previous version still served 40% of traffic. The new version stayed near 0.6% errors, but the old version returned 9%. The rollback-blocked metric went to 100% because the code artifact could not restore the schema or the old-format rows. Switching traffic back made the incident worse, not better.",
  },
  {
    type: "p",
    text: "The fixed sequence keeps the schema additive until the cutover is complete. Backfill gives new readers complete rows. Dual writes keep the old shape valid for the previous version. Only after the old code is drained does the contract step become safe, and even then it removes the ability to roll back to that release.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-version error rate and latency from the load balancer, service mesh, or deployment controller.",
      "Migration state: expand applied, backfill progress, dual-write error rate, and contract status.",
      "Row counts and checksums for the old and new shapes, plus null counts on the new column.",
      "Schema locks, long-running transactions, and replication lag during the migration.",
      "Deployment events correlated with the first error from each version.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the contract step against the traffic still on the previous release. Check backfill and dual-write coverage before blaming the new code. Check whether a code rollback would still find the old shape, and whether rows written by the new version can be read by the old code.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the destructive migration and freeze writes if the schema state is uncertain.",
      "Restore the old shape from the migration or a verified backup before shifting traffic back.",
      "Finish the backfill in batches and verify counts, nulls, and checksums.",
      "Keep dual writes at full coverage until the previous release has no traffic.",
      "Drain the old version, observe a full traffic cycle, then run the contract step.",
      "Record the contract as a one-way door and require a tested restore for the next attempt.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Keeping both shapes costs storage, write amplification, and migration complexity.",
      "A longer dual-write window reduces rollback risk but keeps two sources of truth longer.",
      "A background backfill avoids a long lock but can lag live writes and needs verification.",
      "Contracting early simplifies the schema and removes dead code, but gives up the fast code rollback.",
      "A restore is a recovery option only if it has been tested with the new data volume.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "both-versions",
    question:
      "Blue-green cutover is instant, so why can a schema migration still break the deployment?",
    difficulty: 4,
    hints: [
      "The database is shared by both environments.",
      "The cutover changes traffic, not the schema.",
      "Old code can still receive traffic during the transition.",
    ],
    answer:
      "The application switch is fast, but both environments use the same database. During cutover, some traffic still reaches the old version, and that version runs its old queries. If the migration drops or renames a column the old code uses, the old version fails before the cutover completes, and a code rollback cannot restore the dropped shape. The migration has to expand, backfill, dual-write, and contract after the old code is drained.",
    followUps: [
      "Which step would you run first if the new code needs a renamed column?",
      "How would you prove the old version is drained before contracting?",
      "What does a rollback restore, and what does it not restore?",
    ],
    redFlags: [
      "Assumes blue-green means the database switches too.",
      "Treats a code rollback as a data rollback.",
      "Runs a destructive migration during the cutover.",
    ],
    rubric: [
      "Names the shared database.",
      "Explains the old version's exposure.",
      "Sequences expand and contract.",
      "Separates code from data recovery.",
    ],
  },
  {
    id: "dual-write",
    question:
      "The new version reads a new column. How do you keep it correct while the old version still writes rows?",
    difficulty: 4,
    hints: [
      "Old code does not know the new column exists.",
      "A one-time backfill can fall behind live writes.",
      "Nullable and default values are compatibility tools.",
    ],
    answer:
      "I would add the new column as nullable, deploy code that writes both shapes, and backfill existing rows in batches. While the old version still writes, a change capture or a second write path must fill the new column, or the new reader must tolerate a missing value and fall back to the old shape. I would verify null counts and reconciliation continuously, and only remove the fallback after the old version is drained and coverage is complete.",
    followUps: [
      "What happens if dual writes fail for one minute?",
      "How do you reconcile the two shapes without locking the table?",
      "When is a database trigger better than application dual writes?",
    ],
    redFlags: [
      "Backfills once and assumes no new rows arrive.",
      "Makes the new column required while old code still writes.",
      "Has no reconciliation between shapes.",
    ],
    rubric: [
      "Keeps the new shape nullable during transition.",
      "Covers live writes, not only historical rows.",
      "Measures coverage and divergence.",
      "Removes the fallback only after drain.",
    ],
  },
  {
    id: "rollback-data",
    question:
      "A destructive migration ran and the new version is failing. Why might rolling back the code make the incident worse?",
    difficulty: 4,
    hints: [
      "The old code expects the old shape.",
      "New rows may only exist in the new shape.",
      "A restore has a recovery point objective.",
    ],
    answer:
      "The rollback only changes the code. If the migration dropped the old column, the previous version now queries a schema that no longer exists. If the new version wrote rows in the new shape, the old code may not be able to read them. Rolling back can therefore turn a partial failure into a broader one. I would stop writes, determine whether the schema can be restored, and choose rollback, roll-forward, or restore based on the data, not only the artifact.",
    followUps: [
      "What would you check before shifting traffic back?",
      "How does the recovery point objective affect the choice?",
      "When would you roll forward instead?",
    ],
    redFlags: [
      "Rolls back without checking schema compatibility.",
      "Assumes backups are current and restore-tested.",
      "Ignores rows written after the backup.",
    ],
    rubric: [
      "Separates code rollback from data recovery.",
      "Checks old-code compatibility with new rows.",
      "Considers restore and roll-forward.",
      "Names a verification step before traffic.",
    ],
  },
  {
    id: "contract-gate",
    question:
      "What evidence would you require before running the contract step in production?",
    difficulty: 3,
    hints: [
      "Traffic is only one signal.",
      "The old code may still run in background jobs.",
      "The contract step is hard to reverse.",
    ],
    answer:
      "I would require no production traffic on the previous release, no background jobs or consumers using the old shape, complete backfill with verified counts, clean dual writes, and a tested restore or data-repair plan. I would also check that the new version has survived a full traffic cycle and that dashboards separate per-version errors. Then I would run the contract as a reviewed change with a rollback plan that acknowledges the one-way data risk.",
    followUps: [
      "How do you find consumers that are not in the request path?",
      "What is a reasonable observation window before contracting?",
      "What would you do if the old shape must stay for a contractual retention period?",
    ],
    redFlags: [
      "Uses only request traffic as the drain signal.",
      "Contracts without a restore test.",
      "Has no plan for background consumers.",
    ],
    rubric: [
      "Checks request and non-request consumers.",
      "Requires backfill and dual-write verification.",
      "Requires a tested recovery plan.",
      "Acknowledges the one-way door.",
    ],
  },
];

const checklist = [
  {
    title: "Before the migration",
    items: [
      "List every reader and writer of the shape being changed, including jobs and exports.",
      "Choose an expand shape that old code can ignore and new code can tolerate as null.",
      "Write the backfill plan, batch size, throttle, and verification query.",
      "Define dual-write coverage and reconciliation, including failure behavior.",
      "Set the drain condition and the evidence required before contract.",
    ],
  },
  {
    title: "During the transition",
    items: [
      "Run expand before deploying code that needs the new shape.",
      "Backfill while live writes continue, and monitor null counts and lag.",
      "Keep dual writes at full coverage until the previous version has no traffic.",
      "Compare per-version errors; do not rely on a blended service error rate.",
      "Stop before contract if any old-code consumer remains.",
    ],
  },
  {
    title: "Before the contract",
    items: [
      "Confirm no request, job, or consumer still uses the old shape.",
      "Verify row counts and checksums across both shapes.",
      "Test restore or data repair against the current data volume.",
      "Record the contract as a one-way door with an explicit owner.",
      "Keep the previous artifact available in case an application-only rollback is enough.",
    ],
  },
];

const references = [
  {
    title: "Parallel Change",
    url: "https://martinfowler.com/bliki/ParallelChange.html",
    publisher: "Martin Fowler",
    kind: "docs" as const,
    note: "Expand, migrate, and contract as separate, reversible steps.",
  },
  {
    title: "Implement a blue-green deployment strategy",
    url: "https://docs.aws.amazon.com/prescriptive-guidance/latest/patterns/implement-a-blue-green-deployment-strategy.html",
    publisher: "AWS Prescriptive Guidance",
    kind: "docs" as const,
    note: "Blue-green traffic switching and the shared-state considerations around cutover.",
  },
  {
    title: "ALTER TABLE",
    url: "https://www.postgresql.org/docs/current/sql-altertable.html",
    publisher: "PostgreSQL Documentation",
    kind: "docs" as const,
    note: "Additive and destructive schema operations, defaults, and locking behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "blue-green-migration": {
      model: blueGreenDbMigrationModel,
      presets,
      instructions:
        "Start with Healthy, then apply Contract early and watch the old-version error rate. Return to Recovery to see a compatible sequence. Use the experiment to test what a code rollback can repair.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Traffic shares, error rates, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-expand-contract",
    "deployment-blue-green",
    "deployment-schema-compat",
    "deployment-rollback-data-loss",
  ],
};
