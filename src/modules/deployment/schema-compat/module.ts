import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "newVersionShare",
    label: "Traffic on the new version",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Rollout",
    help: "Share of requests handled by the new code while both versions run. Old readers still see data written by new writers.",
    format: "percent",
  },
  {
    id: "oldReaderStrictness",
    label: "Old reader strictness",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Schema",
    help: "How strictly the old code rejects missing required fields, unknown fields, or changed types. Strict readers turn a schema difference into errors.",
    format: "percent",
  },
  {
    id: "schemaMode",
    label: "Schema change is destructive (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Schema",
    help: "One models a change that removes or renames a field, adds a required field, or changes a type. Zero models an additive, nullable change.",
    format: "count",
  },
  {
    id: "migrationOrder",
    label: "Expand before deploy (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rollout",
    help: "One means the compatible schema is deployed before the code that needs it. Zero means the migration follows the deploy.",
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
  share: number;
  strictness: number;
  destructive: boolean;
  expandFirst: boolean;
  incompatibleFields: number;
  oldErrorRate: number;
  newErrorRate: number;
}

function compute(p: Params): Values {
  const share = clamp(num(p, "newVersionShare", 10), 0, 100);
  const strictness = clamp(num(p, "oldReaderStrictness", 100), 0, 100);
  const destructive = num(p, "schemaMode", 0) >= 0.5;
  const expandFirst = num(p, "migrationOrder", 1) >= 0.5;

  const incompatibleFields = (destructive ? 2 : 0) + (expandFirst ? 0 : 1);
  const oldErrorRate =
    (share / 100) * incompatibleFields * (strictness / 100) * 8 + (expandFirst ? 0 : 0.5);
  const newErrorRate = destructive ? 0.2 : 0;

  return {
    share,
    strictness,
    destructive,
    expandFirst,
    incompatibleFields,
    oldErrorRate,
    newErrorRate,
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
  const oldHealth = highHealth(values.oldErrorRate, 0.5, 2);
  const newHealth = highHealth(values.newErrorRate, 0.5, 2);
  const schemaHealth = highHealth(values.incompatibleFields, 2, 3);

  const stageNodes = [
    {
      id: "old",
      label: "Old version readers",
      kind: "service" as const,
      health: oldHealth,
      utilization: clamp(values.oldErrorRate / 10),
      sublabel: `${percent(values.oldErrorRate)} errors · strict ${percent(values.strictness)}`,
      detail: `Old code handles ${percent(100 - values.share)} of traffic. It must parse records written by the new version, including fields it does not know.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "new",
      label: "New version writers",
      kind: "service" as const,
      health: newHealth,
      utilization: clamp(values.share / 100),
      sublabel: `${percent(values.share)} traffic · ${values.destructive ? "destructive change" : "additive change"}`,
      detail: values.destructive
        ? "The new version changes the shape of the data. Old readers may reject records or read the wrong value while both versions run."
        : "The new version adds nullable fields and tolerates old records. Old readers can still parse the schema.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "schema",
      label: "Shared schema",
      kind: "db" as const,
      health: schemaHealth,
      utilization: clamp(values.incompatibleFields / 4),
      sublabel: `${values.incompatibleFields} incompatible field${values.incompatibleFields === 1 ? "" : "s"}`,
      detail: values.expandFirst
        ? "The compatible schema was expanded before the code deploy, so both versions can read and write during the overlap."
        : "The migration follows the deploy, so new code can write a shape the old code cannot read.",
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "v1", label: "v1 readers", kind: "service" as const, health: oldHealth, meta: { view: "flow" } },
    { id: "v2", label: "v2 writers", kind: "service" as const, health: newHealth, meta: { view: "flow" } },
    {
      id: "store",
      label: "Shared data",
      kind: "db" as const,
      health: schemaHealth,
      sublabel: `${values.incompatibleFields} incompatible fields`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("v1-store", "v1", "store", clamp(1 - values.share / 100), oldHealth),
      edge("v2-store", "v2", "store", clamp(values.share / 100), worst(newHealth, schemaHealth)),
    ],
    metrics: [
      metric("old-errors", "Old version error rate", values.oldErrorRate, "%", 0.5, 2, "percent"),
      metric("new-errors", "New version error rate", values.newErrorRate, "%", 0.5, 2, "percent"),
      metric("incompatible-fields", "Incompatible schema fields", values.incompatibleFields, " fields", 2, 3, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), incompatibleFields: values.incompatibleFields },
    summary: `${values.incompatibleFields} incompatible fields · old errors ${percent(values.oldErrorRate)} · new errors ${percent(values.newErrorRate)}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 6)) / 2.2);
  for (const [id, value] of [
    ["old-errors", values.oldErrorRate],
    ["new-errors", values.newErrorRate],
    ["incompatible-fields", values.incompatibleFields],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "old-errors",
    metricId: "old-errors",
    warn: 0.5,
    crit: 2,
    title: "The old version cannot read the new data",
    cause: "A destructive change removed or renamed a field, added a required field, or changed a type. Old readers are still serving traffic and now reject records written by the new version.",
    fix: "Stop the rollout and deploy backward-compatible code, or restore the previous schema shape. Add nullable defaults and make readers tolerate unknown fields. Sequence the next attempt as expand, migrate, then contract.",
    checkFirst: [
      "Compare the old reader's schema with records written by the new version.",
      "Check whether the failing field is required, renamed, or a different type.",
      "Check the rollout order: schema before code, old code before new writes.",
    ],
  },
  {
    id: "new-errors",
    metricId: "new-errors",
    warn: 0.5,
    crit: 2,
    title: "The new version is failing on the shared schema",
    cause: "The new code expects a field that the old writer or migration has not produced yet, or it cannot parse data written by the old version.",
    fix: "Make the new code read both shapes during the transition: default missing values, ignore extra fields, and write a shape both versions can read. Deploy the compatible reader before the writer that requires it.",
    checkFirst: [
      "Check whether the migration ran before the new code.",
      "Check the new reader's handling of missing and extra fields.",
      "Check whether old writers are still producing the previous shape.",
    ],
  },
  {
    id: "incompatible-fields",
    metricId: "incompatible-fields",
    warn: 2,
    crit: 3,
    title: "The schema change is not compatible across versions",
    cause: "The change requires both versions to agree on a shape that only one of them knows. During a rolling or canary release, both versions must be able to read and write for the overlap window.",
    fix: "Use an expand/contract sequence: add the new nullable shape, dual-write and backfill, move readers, then remove the old shape only after the old version is gone. Never require a new field while old readers still serve traffic.",
    checkFirst: [
      "List every field the old reader requires and the new writer produces.",
      "Check whether readers tolerate unknown fields and missing optional fields.",
      "Check the length of the mixed-version window.",
    ],
  },
];

export const schemaCompatModel: SimModel = {
  id: "deployment-schema-compat",
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
      `${percent(values.share)} of traffic runs the new version while ${percent(100 - values.share)} still runs the old code. Both must read and write the same data during this window.`,
    );
    items.push(
      values.destructive
        ? "The schema change is destructive: a removed, renamed, or newly required field breaks compatibility."
        : "The schema change is additive and nullable. Old readers can still parse records written by the new code.",
    );
    items.push(
      values.expandFirst
        ? "The compatible schema is expanded before the deploy, so both versions have a shape they can read."
        : "The migration follows the deploy, so the new code can write data the old code cannot parse.",
    );
    items.push(
      `Old-version errors are ${percent(values.oldErrorRate)} and new-version errors are ${percent(values.newErrorRate)}. The old version is often the forgotten failure domain.`,
    );
    return items;
  },
  legend: [
    { label: "Compatible", tone: "ok" },
    { label: "Bridging", tone: "warn" },
    { label: "Incompatible", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "An additive nullable field, expanded before the deploy, with tolerant readers.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Strict readers",
    description: "A destructive change is avoided, but a new field is required while strict old readers still serve traffic.",
    tone: "warn",
    params: defaults({ newVersionShare: 10, oldReaderStrictness: 50, schemaMode: 1, migrationOrder: 1 }),
  },
  {
    id: "failure",
    label: "Required field",
    description: "Half the traffic writes a destructive shape and the migration follows the deploy.",
    tone: "crit",
    params: defaults({ newVersionShare: 50, oldReaderStrictness: 100, schemaMode: 1, migrationOrder: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The change is additive and the schema is expanded before the code deploy.",
    tone: "ok",
    params: defaults({ newVersionShare: 100, oldReaderStrictness: 100, schemaMode: 0, migrationOrder: 1 }),
  },
  {
    id: "small-share",
    label: "Small share",
    description: "Only 20% of traffic is new, but a required field still breaks old readers.",
    tone: "crit",
    params: defaults({ newVersionShare: 20, oldReaderStrictness: 100, schemaMode: 1, migrationOrder: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-schema-rule",
  title: "Predict the rule for a mixed-version window",
  simId: "schema-compat",
  question:
    "Old and new versions will run side by side for an hour. The new version needs a field the old one does not know. What is the safe schema rule?",
  prediction: {
    options: [
      { id: "compatible", label: "Make the field optional with a default and keep readers tolerant of extra data" },
      { id: "required", label: "Add the field as required so the new code can rely on it" },
      { id: "cutover", label: "Deploy both versions at the same time and skip the overlap" },
      { id: "old-off", label: "Turn off the old version before writing any new data" },
    ],
    correctOptionId: "compatible",
    explanation:
      "During the overlap, old readers must be able to parse records written by new writers. An optional field with a default preserves that compatibility, and tolerant readers handle both shapes. A required field breaks the old version, and skipping the overlap only hides the problem until the next mixed-version event.",
  },
  setup: defaults({ newVersionShare: 50, oldReaderStrictness: 100, schemaMode: 1, migrationOrder: 0 }),
  runFor: 30,
  observe: [
    "Three incompatible fields appear between old readers and the new writer.",
    "Old-version errors reach 12.5% while new-version errors stay near 0.2%.",
    "The old version handles half the traffic and cannot parse the new shape.",
    "Migration order adds another failure before the schema is ready.",
  ],
  explain:
    "Compatibility is about both directions. Old readers must tolerate new data, and new readers must tolerate old data. A required field is a one-way door: the writer can produce it, but the old reader cannot invent it. Expand the schema first, keep both shapes readable, and contract only when the old version is gone.",
  fix: defaults({ newVersionShare: 100, oldReaderStrictness: 100, schemaMode: 0, migrationOrder: 1 }),
  debrief:
    "The fix uses an additive nullable field and expands the schema before deploying the new code. Old-version errors fall to zero and the new version remains healthy. The cost is a longer migration sequence and temporary dual writes, which is cheaper than a rollback that cannot read the data already written.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Schema compatibility is the property that lets two versions of a service read and write the same data during a rollout. Backward compatibility means new code can read data written by old code. Forward compatibility means old code can read data written by new code. A rolling or canary release needs both, because old and new versions overlap for minutes or hours.",
  },
  {
    type: "p",
    text: "Adding an optional field with a default is usually compatible in both directions. Removing a field, renaming it, changing its type, or adding a required field is not. The old reader may reject the record, and the new writer may produce a shape the old reader cannot parse. The failure often appears on the old version, which is the version the team stopped thinking about.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The schema sits between producers and consumers: a database table, an event topic, a cache value, or an API payload. During a rollout, the deploy controller keeps both versions alive while health checks and traffic shifting proceed. The migration system changes the stored shape. The compatibility rule must hold across all three for the entire overlap window, not only at the final state.",
  },
  {
    type: "p",
    text: "The error rates and field counts in this model are illustrative. The structure is the lesson: compatibility is a property of the pair of versions, not of the schema alone. A change that looks safe in the new code can still break the old reader that is serving half the traffic.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Old-version error rate: the version that is often forgotten during a rollout.",
      "New-version error rate: failures caused by data written before the migration.",
      "Incompatible schema fields: removed, renamed, required, or retyped fields.",
      "Traffic share on the new version and whether the schema was expanded first.",
      "A shared schema node showing the mixed-version window.",
    ],
  },
  {
    type: "table",
    headers: ["Change", "Backward compatible?", "Forward compatible?", "Safe during overlap?"],
    rows: [
      ["Add optional field with default", "Usually", "Usually", "Yes"],
      ["Add required field", "No for old readers", "Yes", "No"],
      ["Remove field", "Yes if readers ignore it", "No", "Only after old readers are gone"],
      ["Rename field", "No", "No", "Use add, backfill, then remove"],
      ["Change type", "No", "No", "Use a new field and migrate"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and note that old and new versions coexist without errors. Apply Required field to see old-version errors rise while the new version stays healthy. Apply Small share to see that a small rollout does not protect the old reader. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "schema-compat" },
  { type: "experiment", experimentId: "predict-schema-rule" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the new version wrote a destructive shape while the old version still served half the traffic. Old-version errors reached 12.5%, and the migration ran after the deploy, adding a transition where neither version had a stable schema. The new version looked healthy because it could read its own data.",
  },
  {
    type: "p",
    text: "The small-share preset shows that a 20% rollout is not a safety margin. The old version still reads the new shape for the records it receives, and strict readers fail on the field they do not know. Compatibility is about the pair of versions, not the percentage.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Old-version errors that begin when the new version starts writing.",
      "Deserialization errors naming a missing or unknown field.",
      "A migration that ran after the deploy and changed the shape under old readers.",
      "New-version errors when a backfill has not reached old records.",
      "Rollback failing because the old code cannot read data written by the new version.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the old reader's schema with records written by the new version. Check whether the failing field is required, renamed, or a different type. Check whether the schema was expanded before the code deploy. Check the old version's error rate, not only the new version's.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the rollout and restore the previous writer or schema shape.",
      "Make the new field optional and give old readers a safe default.",
      "Make readers tolerate unknown and missing fields.",
      "Expand the schema before the code deploy, then backfill and dual-write.",
      "Move all readers to the new shape before removing the old one.",
      "Test the rollback path against data written by the new version.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Expand/contract is safer but takes more deploys and a longer migration window.",
      "Dual writes preserve compatibility but add cost and a temporary consistency problem.",
      "Tolerant readers handle version skew but can hide a missing value that should be an error.",
      "A required field simplifies the new code but makes rollback and mixed-version operation unsafe.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "mixed-version",
    question:
      "Old and new versions will run together for an hour. What schema rules do you apply?",
    difficulty: 3,
    hints: [
      "Both directions matter.",
      "Old readers are a failure domain.",
      "Expand before deploy, contract after drain.",
    ],
    answer:
      "I would require both versions to read and write during the overlap. New fields must be optional with defaults, readers must tolerate unknown fields, and no field can be removed or retyped until the old version is gone. I would expand the schema first, backfill and dual-write if needed, move readers, then contract. I would test the old reader against records written by the new writer before the rollout, and I would verify rollback against new data.",
    followUps: [
      "What if the old version cannot be changed?",
      "How long can the overlap window be?",
      "How would you test forward compatibility?",
    ],
    redFlags: ["Adds a required field.", "Assumes the old version is gone.", "Tests only the new code."],
    rubric: ["Covers both directions.", "Uses optional fields.", "Sequences expand and contract.", "Tests old readers."],
  },
  {
    id: "rollback",
    question:
      "A release added a required column. Rollback fails because the old code cannot read it. What should have been different?",
    difficulty: 3,
    hints: [
      "The old code has to survive the new data.",
      "A nullable column is a bridge.",
      "Rollback is part of the schema design.",
    ],
    answer:
      "The column should have been added as nullable with a default, and the new code should tolerate records without it. That gives the old code a shape it can read during rollback. The migration should have been expanded before the deploy, with a backfill and a later contract step. If the column is already required, I would restore compatibility by making it nullable or by adding a transitional dual-write before attempting rollback.",
    followUps: [
      "Can you roll back after the backfill?",
      "What if the column already contains data the old code cannot parse?",
      "When is roll-forward safer than rollback?",
    ],
    redFlags: ["Drops the column immediately.", "Assumes code rollback is enough.", "Ignores existing data."],
    rubric: ["Uses nullable default.", "Sequences expand/contract.", "Preserves old reads.", "Considers data."],
  },
  {
    id: "compatibility-test",
    question: "How do you test schema compatibility before a rolling deploy?",
    difficulty: 2,
    hints: [
      "Test both directions.",
      "Use real payloads, not only the new schema.",
      "Include rollback.",
    ],
    answer:
      "I would run the old reader against payloads produced by the new writer and the new reader against payloads produced by the old writer. I would use recorded production payloads plus edge cases such as missing optional fields, unknown fields, and nulls. In a schema registry, I would run the compatibility check for the configured mode. I would also test a rollback against data written during the new version's lifetime.",
    followUps: [
      "Which compatibility mode would you choose?",
      "What payloads are easy to miss?",
      "How do you keep the test current as the schema evolves?",
    ],
    redFlags: ["Tests only new-to-new.", "Uses synthetic happy paths only.", "Skips rollback."],
    rubric: ["Tests both directions.", "Uses real payloads.", "Covers edge cases.", "Tests rollback."],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "List the old and new readers and the fields each requires.",
      "Make new fields optional with defaults; avoid required fields during overlap.",
      "Confirm readers tolerate unknown fields and missing optional values.",
      "Expand the schema before deploying code that needs it.",
      "Test old readers against new payloads and rollback against new data.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch old-version errors as closely as new-version errors.",
      "Check deserialization and validation failures by version.",
      "Keep both shapes readable until the old version is drained.",
      "Stop the rollout if the old version cannot parse new records.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Backfill and verify the new shape before contracting.",
      "Remove the old shape only after the old version is gone.",
      "Record the compatibility mode and migration sequence.",
      "Add the mixed-version payloads to the compatibility test suite.",
    ],
  },
];

const references = [
  {
    title: "Apache Avro specification: schema resolution",
    url: "https://avro.apache.org/docs/1.12.0/specification/",
    publisher: "Apache Avro",
    kind: "docs" as const,
    note: "Reader and writer schema resolution, defaults, and compatibility rules.",
  },
  {
    title: "Kubernetes Deployments",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Rolling updates and the mixed-version window during a rollout.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "schema-compat": {
      model: schemaCompatModel,
      presets,
      instructions:
        "Start with Healthy, then apply Required field to see old-version errors. Apply Small share to show that a small rollout does not protect old readers. Apply Recovery, then run the experiment and its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Error rates and field counts are teaching values, not schema-registry guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-expand-contract", "deployment-blue-green", "deployment-rollback-vs-rollforward", "deployment-rollback-data-loss"],
};
