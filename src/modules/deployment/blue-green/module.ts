import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 20_000;
const BASELINE_ERROR = 0.1;
const DESTRUCTIVE_LEGACY_ERROR = 4.5;

const params: ParamSpec[] = [
  {
    id: "cutoverPercent",
    label: "Traffic on green",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Cutover",
    help: "Share of production traffic sent to the green environment. Zero leaves blue serving; 100 completes the switch.",
    format: "percent",
  },
  {
    id: "greenErrorRate",
    label: "Green error rate",
    min: 0,
    max: 10,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Release",
    help: "Requests to the green version that return an error, independent of the database schema.",
    format: "percent",
  },
  {
    id: "schemaStep",
    label: "Schema step (0 none, 1 additive, 2 destructive)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Shared database",
    help: "Zero is no schema change. One adds a nullable column or table that old code can ignore. Two renames or drops a column the old version still queries, which breaks rollback.",
    format: "count",
  },
  {
    id: "greenCapacityPercent",
    label: "Green capacity",
    min: 50,
    max: 150,
    step: 5,
    value: 120,
    unit: "%",
    group: "Capacity",
    help: "Green capacity as a share of full production demand. Running both environments also doubles connection pools, caches, and background workers.",
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
  cutoverPercent: number;
  cutover: number;
  greenError: number;
  schemaStep: number;
  destructive: boolean;
  greenCapacityPercent: number;
  greenCapacityRps: number;
  legacyError: number;
  serviceError: number;
  capacityShortfall: number;
  greenUtilization: number;
  rollbackBlocked: number;
  greenTraffic: number;
  blueTraffic: number;
}

function compute(p: Params): Values {
  const cutoverPercent = clamp(num(p, "cutoverPercent", 100), 0, 100);
  const cutover = cutoverPercent / 100;
  const greenError = clamp(num(p, "greenErrorRate", 0.1), 0, 100);
  const schemaStep = Math.max(0, Math.round(num(p, "schemaStep", 1)));
  const destructive = schemaStep >= 2;
  const greenCapacityPercent = Math.max(1, num(p, "greenCapacityPercent", 120));
  const greenCapacityRps = (greenCapacityPercent / 100) * TOTAL_RPS;
  const legacyError = destructive ? Math.min(100, DESTRUCTIVE_LEGACY_ERROR + greenError * 0.1) : BASELINE_ERROR;
  const serviceError = cutover * greenError + (1 - cutover) * legacyError;
  const capacityShortfall = Math.max(0, cutoverPercent - greenCapacityPercent);
  const greenUtilization = cutoverPercent / greenCapacityPercent;
  const rollbackBlocked = destructive ? 100 : 0;

  return {
    cutoverPercent,
    cutover,
    greenError,
    schemaStep,
    destructive,
    greenCapacityPercent,
    greenCapacityRps,
    legacyError,
    serviceError,
    capacityShortfall,
    greenUtilization,
    rollbackBlocked,
    greenTraffic: cutover * TOTAL_RPS,
    blueTraffic: (1 - cutover) * TOTAL_RPS,
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

function capacityHealth(shortfall: number): Health {
  if (shortfall >= 20) return "crit";
  if (shortfall >= 5) return "warn";
  return "ok";
}

function utilizationHealth(value: number): Health {
  if (value > 1) return "crit";
  if (value >= 0.9) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function buildFrame(values: Values, seed: number): SimFrame {
  const green = worst(errorHealth(values.greenError), utilizationHealth(values.greenUtilization), capacityHealth(values.capacityShortfall));
  const blue: Health = values.cutover >= 0.999 ? "ok" : errorHealth(values.legacyError);
  const schema: Health = values.destructive ? "crit" : "ok";
  const overall = worst(green, blue, schema, errorHealth(values.serviceError));

  const stageNodes = [
    {
      id: "blue",
      label: "Blue environment",
      kind: "service" as const,
      health: blue,
      utilization: clamp(1 - values.cutover),
      throughput: values.blueTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent((1 - values.cutover) * 100)} of traffic · previous release`,
      detail: values.cutover >= 0.999
        ? "Blue is idle after the cutover. It is the rollback target only if its code and the shared schema are still compatible."
        : `Blue still serves ${percent((1 - values.cutover) * 100)} of traffic. A destructive schema change can break these requests before the cutover finishes.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "green",
      label: "Green environment",
      kind: "service" as const,
      health: green,
      utilization: clamp(values.greenUtilization),
      throughput: values.greenTraffic,
      capacity: values.greenCapacityRps,
      sublabel: `${percent(values.cutover * 100)} of traffic · ${percent(values.greenCapacityPercent)} capacity`,
      detail: `Green serves ${Math.round(values.greenTraffic).toLocaleString()} rps with ${Math.round(values.greenCapacityRps).toLocaleString()} rps of modeled capacity. Its error rate is ${percent(values.greenError)}.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "schema",
      label: "Shared database",
      kind: "db" as const,
      health: schema,
      utilization: values.destructive ? 1 : 0.55,
      sublabel: values.destructive ? "Destructive change · rollback blocked" : values.schemaStep === 1 ? "Additive change · both versions compatible" : "No schema change",
      detail: values.destructive
        ? "The schema no longer matches the old version's queries. Switching traffic back does not repair the data shape, so rollback is blocked."
        : "Both versions can read and write the schema. The old version can ignore the new nullable fields.",
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
      sublabel: `${TOTAL_RPS.toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "router",
      label: "Traffic switch",
      kind: "lb" as const,
      health: overall,
      utilization: clamp(values.cutover),
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.cutover * 100)} to green`,
      meta: { view: "flow" },
    },
    {
      id: "flow-blue",
      label: "Blue",
      kind: "service" as const,
      health: blue,
      throughput: values.blueTraffic,
      capacity: TOTAL_RPS,
      sublabel: "previous release",
      meta: { view: "flow" },
    },
    {
      id: "flow-green",
      label: "Green",
      kind: "service" as const,
      health: green,
      throughput: values.greenTraffic,
      capacity: values.greenCapacityRps,
      sublabel: "new release",
      meta: { view: "flow" },
    },
    {
      id: "flow-db",
      label: "Shared database",
      kind: "db" as const,
      health: schema,
      sublabel: values.destructive ? "incompatible" : "compatible",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-router", "clients", "router", 1, overall),
      edge("router-blue", "router", "flow-blue", clamp(1 - values.cutover), blue),
      edge("router-green", "router", "flow-green", clamp(values.cutover), green),
      edge("blue-db", "flow-blue", "flow-db", clamp(1 - values.cutover), schema),
      edge("green-db", "flow-green", "flow-db", clamp(values.cutover), schema),
    ],
    metrics: [
      metric("service-error-rate", "Service error rate", values.serviceError, "%", 1, 3, "percent"),
      metric("green-error-rate", "Green error rate", values.greenError, "%", 1, 5, "percent"),
      metric("legacy-error-rate", "Blue error rate", values.legacyError, "%", 1, 3, "percent"),
      metric("rollback-blocked", "Rollback blocked", values.rollbackBlocked, "%", 1, 50, "percent"),
      metric("capacity-shortfall", "Capacity shortfall", values.capacityShortfall, " pts", 5, 20, "number"),
      metric("green-utilization", "Green utilization", values.greenUtilization * 100, "%", 90, 100, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${percent(values.cutover * 100)} on green · service errors ${percent(values.serviceError)} · ${values.destructive ? "rollback blocked by schema" : "rollback path compatible"}`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const ids = ["service-error-rate", "green-error-rate", "legacy-error-rate", "rollback-blocked", "capacity-shortfall", "green-utilization"];
  for (const id of ids) {
    const item = frame.metrics.find((entry) => entry.id === id);
    if (!item) continue;
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      if (item.value === 0) return 0;
      return Math.max(0, item.value * (0.97 + 0.03 * Math.sin((index + (seed % 7)) / 2.9)));
    });
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "service-error-rate",
    metricId: "service-error-rate",
    warn: 1,
    crit: 3,
    title: "The service is returning errors during cutover",
    cause:
      "Traffic is reaching a version that cannot serve it, or green does not have enough capacity for its share. The blended service error rate hides which side is failing, so the per-version signals matter.",
    fix:
      "Stop the cutover, shift traffic back if the rollback path is compatible, and compare blue and green errors. Fix capacity or the application before retrying.",
    checkFirst: [
      "Compare blue and green error rates separately.",
      "Check whether errors started before or after the traffic shift.",
      "Check database errors and connection pool saturation on both versions.",
    ],
  },
  {
    id: "green-error-rate",
    metricId: "green-error-rate",
    warn: 1,
    crit: 5,
    title: "Green is not healthy enough to receive traffic",
    cause:
      "The new version has an application defect or a dependency problem. A green environment that passes a process health check can still fail real requests.",
    fix:
      "Keep traffic on blue and fix the green release. Verify the critical user path, not only the health endpoint, before cutting over.",
    checkFirst: [
      "Run a smoke test against green with real dependencies.",
      "Compare green logs and traces with blue for the same endpoint.",
      "Check whether the failure is present at zero traffic or only under load.",
    ],
  },
  {
    id: "legacy-error-rate",
    metricId: "legacy-error-rate",
    warn: 1,
    crit: 3,
    title: "The old version is failing against the new schema",
    cause:
      "A destructive schema change removed or renamed something the blue code still queries. Old versions must remain compatible with the schema for as long as they can receive traffic or serve as a rollback target.",
    fix:
      "Stop the migration. Use expand/contract: add the new shape, dual-write and backfill, move reads, then remove the old shape only after the old version is drained and cannot be needed for rollback.",
    checkFirst: [
      "Check which schema migration ran and when.",
      "Check blue query errors for missing columns or type mismatches.",
      "Check whether the rollback target is still running the old code.",
    ],
  },
  {
    id: "rollback-blocked",
    metricId: "rollback-blocked",
    warn: 1,
    crit: 50,
    title: "Rollback is blocked by the schema",
    cause:
      "The database now requires or produces a shape that the blue version cannot read or write. Traffic can be switched back, but the old code will fail against the current data.",
    fix:
      "Do not describe the release as reversible. Roll forward with a compatible fix or restore the schema and data from a verified backup. Expand/contract avoids this state by keeping both shapes valid during the transition.",
    checkFirst: [
      "Test the old version against the current schema before cutover.",
      "Check whether the migration can be rolled back without data loss.",
      "Confirm the previous artifact and its schema expectations are recorded.",
    ],
  },
  {
    id: "capacity-shortfall",
    metricId: "capacity-shortfall",
    warn: 5,
    crit: 20,
    title: "Green cannot carry its traffic share",
    cause:
      "Green capacity is smaller than the share being shifted to it. Blue-green requires enough green capacity for the target share, plus room for both connection pools and background work during the overlap.",
    fix:
      "Add green capacity, lower the cutover share, or shift traffic in stages. Do not assume a successful health check proves capacity under production load.",
    checkFirst: [
      "Compare green request rate with green capacity and instance count.",
      "Check CPU, memory, and connection pool utilization on green.",
      "Check shared database connection limits while both versions run.",
    ],
  },
  {
    id: "green-utilization",
    metricId: "green-utilization",
    warn: 90,
    crit: 100,
    title: "Green is at its capacity limit",
    cause:
      "The traffic share is at or above green's modeled capacity. Queueing and errors follow once utilization passes the safe range.",
    fix:
      "Reduce the traffic share or add green capacity before continuing. Keep headroom for the loss of one instance or zone.",
    checkFirst: [
      "Check per-instance utilization, not only the fleet average.",
      "Check autoscaling events and instance readiness.",
      "Check whether the database, not the application, is the limiting resource.",
    ],
  },
];

export const blueGreenModel: SimModel = {
  id: "deployment-blue-green",
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
  step: (frame, p, dt, rng) => {
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
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10) * 0.02;
    next.metrics = next.metrics.map((item) =>
      item.id === "service-error-rate" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines: string[] = [];
    lines.push(
      `${percent(values.cutover * 100)} of traffic is on green. Blue still carries ${Math.round(values.blueTraffic).toLocaleString()} rps and green carries ${Math.round(values.greenTraffic).toLocaleString()} rps.`,
    );
    if (values.destructive) {
      lines.push(
        "The schema change is destructive. The old version cannot be trusted against the current data, so a traffic switch is not a rollback. This is the difference between an environment switch and a state-compatible release.",
      );
    } else {
      lines.push(
        values.schemaStep === 1
          ? "The schema change is additive, so both versions can read and write. The rollback target remains viable while blue is still deployed."
          : "There is no schema change in this configuration. Rollback depends on the previous artifact and configuration still being available.",
      );
    }
    if (values.capacityShortfall > 0) {
      lines.push(`Green capacity is short by ${values.capacityShortfall.toFixed(0)} percentage points for the current cutover share.`);
    } else {
      lines.push(`Green has ${(values.greenCapacityPercent - values.cutoverPercent).toFixed(0)} percentage points of modeled headroom for the current cutover share.`);
    }
    lines.push("A blue-green switch is only as fast as its rollback path. Test that path against the schema, not just against the load balancer.");
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
    label: "Healthy cutover",
    description: "Green receives all traffic with an additive schema and 120 percent capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak cutover",
    description: "Ninety percent on green at 95 percent capacity. Errors and green utilization enter the warning band.",
    tone: "warn",
    params: defaults({ cutoverPercent: 90, greenErrorRate: 1.2, schemaStep: 1, greenCapacityPercent: 95 }),
  },
  {
    id: "failure",
    label: "Destructive migration",
    description: "A column was renamed before cutover. Green also has a 6 percent error rate.",
    tone: "crit",
    params: defaults({ cutoverPercent: 100, greenErrorRate: 6, schemaStep: 2, greenCapacityPercent: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The schema is additive again, green errors are at baseline, and capacity has headroom.",
    tone: "ok",
    params: defaults({ cutoverPercent: 100, greenErrorRate: 0.1, schemaStep: 1, greenCapacityPercent: 120 }),
  },
  {
    id: "partial-cutover",
    label: "Partial cutover",
    description: "Fifty percent of traffic remains on blue after a destructive schema change. Blue is already failing.",
    tone: "crit",
    params: defaults({ cutoverPercent: 50, greenErrorRate: 0.2, schemaStep: 2, greenCapacityPercent: 120 }),
  },
];

const experiment: Experiment = {
  id: "predict-rollback",
  title: "Predict whether the switch is a rollback",
  simId: "blue-green-cutover",
  question:
    "The green environment is healthy and you shift 100 percent of traffic to it. The migration renamed a column that the blue version still queries. Can you roll back by switching traffic to blue?",
  prediction: {
    options: [
      { id: "yes-artifact", label: "Yes. The blue artifact is still deployed, so the switch is a rollback" },
      { id: "no-schema", label: "No. The old code cannot read the new schema, so switching traffic back is not a working rollback" },
      { id: "yes-cache", label: "Yes, after clearing the cache" },
      { id: "yes-dns", label: "Yes, as long as the DNS record still points at blue" },
    ],
    correctOptionId: "no-schema",
    explanation:
      "Blue-green makes the traffic switch fast, but it does not make shared state reversible. If the migration renamed or dropped a column the old code uses, blue will fail as soon as it receives requests. The rollback target is the previous artifact plus a compatible schema, not just the idle environment.",
  },
  setup: defaults({ cutoverPercent: 100, greenErrorRate: 6, schemaStep: 2, greenCapacityPercent: 100 }),
  runFor: 15,
  observe: [
    "Rollback blocked is 100 percent; the model treats the switch as unavailable as a recovery path.",
    "The shared database node is critical even though green has capacity.",
    "Service errors follow green at 6 percent because all traffic is already there.",
    "Blue requests would fail at about 6 percent against the renamed schema, so the idle environment is not a safe target.",
  ],
  explain:
    "A blue-green cutover moves traffic. Rollback restores the previous application behavior against the current data. Those are different operations when the schema changed. Additive changes keep both versions compatible; destructive changes break the old version while it is still a rollback candidate. Expand/contract separates the schema change from the traffic switch so each step is reversible.",
  fix: defaults({ cutoverPercent: 100, greenErrorRate: 0.1, schemaStep: 1, greenCapacityPercent: 120 }),
  debrief:
    "With an additive schema, both versions can read and write, and the rollback path stays open. That does not make the migration free: the old column still consumes space, dual writes add work, and cleanup must wait until the old version is drained. The tradeoff is deliberate compatibility during the transition instead of a fast switch into an irreversible state.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Blue-green deployment runs two complete environments. Blue serves production while green receives the new release and is verified. When green is ready, the router or DNS layer shifts traffic to it. If something goes wrong, the switch can move traffic back to blue. The environments are usually identical in capacity; only one receives production traffic at a time.",
  },
  {
    type: "p",
    text: "The fast part is traffic. The hard part is state. A database, cache, queue, or object store is shared by both environments, and it does not switch when the router does. If the new version changes the schema in a way the old version cannot read, the idle blue environment is no longer a working rollback target. The release is still reversible at the load balancer and irreversible at the data layer.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The traffic switch sits at the load balancer, service mesh, or domain name system (DNS) layer. The deployment controller builds and verifies green. The shared database sits underneath both environments. Blue-green also doubles connection pools, caches, background workers, and any singleton process that assumes one active environment, so capacity planning is not just two copies of the application fleet.",
  },
  {
    type: "p",
    text: "This model uses an illustrative 20,000 rps workload and a three-step schema setting. Zero means no change, one means an additive change that old code can ignore, and two means a destructive rename or drop that breaks old queries. The capacity, error rates, and thresholds are teaching values. The decision shape is the lesson: environment readiness does not prove rollback readiness.",
  },
  {
    type: "compare",
    leftTitle: "Blue-green",
    rightTitle: "Rolling",
    rows: [
      { label: "Traffic switch", left: "One cutover from blue to green", right: "Gradual replacement in batches" },
      { label: "Rollback", left: "Switch traffic back to the idle environment if the schema is compatible", right: "Reverse the rollout or deploy the previous version" },
      { label: "Capacity cost", left: "Two full environments during the release", right: "Surge capacity for one batch" },
      { label: "State risk", left: "Shared schema must support both versions", right: "Both versions run side by side during the rollout" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Traffic on green and the traffic split between environments.",
      "Green error rate, blue error rate, and the blended service error rate.",
      "Rollback blocked: whether the old version can still operate against the current schema.",
      "Green capacity shortfall and utilization at the selected cutover share.",
      "A shared database node that reflects schema compatibility, not application health.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy cutover. Then apply Destructive migration: the green environment may look healthy while the shared database and rollback path are critical. Apply Partial cutover to see blue fail before the switch finishes. Use the experiment to test whether a traffic switch is a rollback, then apply Recovery.",
  },
  {
    type: "table",
    headers: ["Schema step", "Old version still works", "Rollback path", "Safe next action"],
    rows: [
      ["None", "Yes", "Traffic switch back to blue", "Verify the artifact and configuration"],
      ["Additive", "Yes, if old code ignores new fields", "Usually yes", "Dual-write, backfill, then drain blue"],
      ["Destructive", "No", "Blocked", "Roll forward or restore data, not just traffic"],
    ],
  },
  {
    type: "p",
    text: "The break condition is a schema change under the old version. If the blue code queries a column that the migration renamed, blue returns errors even though its processes are healthy. The same failure appears during a partial cutover, before the switch is complete. Expand/contract avoids it by adding the new shape first, keeping both shapes valid, backfilling, and removing the old shape only after the old version is drained.",
  },
  { type: "sim", simId: "blue-green-cutover" },
  { type: "experiment", experimentId: "predict-rollback" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, green received all traffic with a 6 percent error rate, and the shared database had a destructive schema change. The service error rate was critical, but the more important signal was rollback blocked: switching traffic back to blue would not restore service because blue could not read the new schema. The idle environment was available and useless as a recovery path.",
  },
  {
    type: "p",
    text: "The partial-cutover preset showed the same incompatibility before the switch finished. Half of production traffic was still on blue, and blue was already failing against the renamed column. That is why a blue-green plan must test both versions against the schema, not only the new version against its health check.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-environment error rate, latency, request count, and instance health.",
      "Database errors by version, including missing column and type mismatch errors.",
      "Migration events and schema version per environment.",
      "Connection pool counts and limits while both environments run.",
      "Rollback test results from the previous artifact against the current schema.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the migration is additive or destructive before trusting the switch. Run the old version against the current schema, not only the new version. Compare blue and green errors separately, and check shared database connection limits while both environments are active.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the cutover and decide whether the schema can be restored without losing data.",
      "If rollback is blocked, roll forward with a compatible fix or restore from a verified backup.",
      "Use expand/contract for the next attempt: add the new shape, dual-write, backfill, move reads, then remove the old shape.",
      "Drain the old version before removing the old column, and keep the previous artifact until the compatibility window closes.",
      "Test the rollback path against production-like data before the next release.",
      "Record schema expectations with the artifact so the next responder knows what rollback requires.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Blue-green gives a fast traffic switch, but duplicate environments cost money and double some shared resources.",
      "A destructive migration is simpler to reason about after it completes, but it removes the rollback path during the risk window.",
      "Expand/contract keeps both versions compatible but adds migration steps, dual writes, and cleanup work.",
      "Keeping blue idle for a long rollback window costs capacity; shutting it down early saves money and reduces recovery options.",
      "DNS cutovers are simple but cached clients and TTLs can make a rollback slower than a load balancer switch.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cutover-decision",
    question:
      "Green is healthy in staging and the database migration is not reversible. Do you cut over?",
    difficulty: 3,
    hints: [
      "Separate application readiness from data reversibility.",
      "Ask what rollback means after the migration.",
      "A backup is not a rollback plan until restore time is tested.",
    ],
    answer:
      "Not until I understand the recovery path. If the migration is destructive and the old version cannot operate against the new schema, a traffic switch back to blue is not a rollback. I would either make the change backward compatible first, or explicitly choose a roll-forward plan with a tested fix and a restore path. I would also verify that the old version is not serving traffic during the migration and that the backup restore meets the recovery objective.",
    followUps: [
      "What would make the migration reversible?",
      "How long do you keep blue running?",
      "What do you tell the incident commander if rollback is blocked?",
    ],
    redFlags: [
      "Treats the idle environment as a rollback regardless of schema.",
      "Cuts over without testing the old version.",
      "Claims a backup is a rollback without a restore test.",
    ],
    rubric: [
      "Separates traffic from state.",
      "Tests old code against new schema.",
      "Chooses roll-forward or compatibility deliberately.",
      "Names a recovery objective.",
    ],
  },
  {
    id: "expand-contract",
    question:
      "You need to rename a column used by the current release. How do you sequence it so blue-green can roll back?",
    difficulty: 4,
    hints: [
      "Add before you remove.",
      "Both versions must read and write during the overlap.",
      "The cleanup step comes after the old version is drained.",
    ],
    answer:
      "I would use expand/contract. First add the new column and deploy code that writes both old and new shapes while still reading the old one. Backfill existing rows, then move reads to the new column. After the old version is fully drained and the rollback window is closed, stop writing the old column and drop it. Each step is independently deployable and the old version remains viable until the final contract step.",
    followUps: [
      "How do you verify the backfill is complete?",
      "What if a write fails between the two shapes?",
      "When is it safe to drop the old column?",
    ],
    redFlags: [
      "Renames the column in one step.",
      "Drops the old column before draining old code.",
      "Backfills without handling concurrent writes.",
    ],
    rubric: [
      "Adds the new shape first.",
      "Dual-writes and backfills.",
      "Moves reads before removing writes.",
      "Waits for old code to drain before contract.",
    ],
  },
  {
    id: "capacity-overlap",
    question:
      "Blue-green doubles the application fleet during cutover. What shared resources do you check before shifting traffic?",
    difficulty: 3,
    hints: [
      "The database sees both connection pools.",
      "Caches and queues may have per-environment consumers.",
      "Background workers can duplicate work.",
    ],
    answer:
      "I would check database connection limits and pool sizing, cache capacity and key ownership, queue consumer counts, external API quotas, and any singleton background job that could run twice. I would also check that green has enough capacity for the target share and that autoscaling can react before the cutover. The application fleet is the visible cost; shared dependencies are where the overlap usually breaks.",
    followUps: [
      "How do you prevent duplicate queue consumption?",
      "What if the database connection limit is fixed?",
      "How would you test the overlap before production?",
    ],
    redFlags: [
      "Checks only application CPU.",
      "Ignores duplicate background workers.",
      "Assumes the database scales with the app fleet.",
    ],
    rubric: [
      "Names shared dependencies.",
      "Checks connection limits and quotas.",
      "Addresses duplicate workers.",
      "Plans capacity for the overlap.",
    ],
  },
  {
    id: "failed-cutover",
    question:
      "You cut over to green and see a 4 percent error rate. Blue is still running. What is your first move?",
    difficulty: 3,
    hints: [
      "Stop the exposure before diagnosing.",
      "Check whether rollback is actually compatible.",
      "Preserve the green evidence.",
    ],
    answer:
      "I would stop the cutover and shift traffic back only if the schema and data still support blue. If rollback is compatible, that is the fastest way to stop user impact. If it is not, I would keep the traffic where it is only if green is the lesser failure, or roll forward with a fix. In parallel I would preserve green logs, traces, and database errors, and communicate the current impact and recovery path.",
    followUps: [
      "How do you decide between rollback and roll-forward?",
      "What evidence do you preserve?",
      "When do you escalate to an incident?",
    ],
    redFlags: [
      "Rolls back without checking schema compatibility.",
      "Keeps sending traffic to a failing version while debugging.",
      "Does not communicate the recovery path.",
    ],
    rubric: [
      "Stops exposure first.",
      "Checks rollback compatibility.",
      "Preserves evidence.",
      "Chooses rollback or roll-forward explicitly.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Confirm both environments can run the same schema version.",
      "Classify the migration as additive or destructive and write the rollback path.",
      "Test the previous artifact against the new schema with production-like data.",
      "Size green capacity for the target share plus one failure domain.",
      "Check shared connection pools, quotas, caches, and background workers.",
    ],
  },
  {
    title: "During cutover",
    items: [
      "Shift traffic in stages and compare per-environment errors.",
      "Watch database errors and connection limits on both versions.",
      "Stop if green error rate or capacity crosses the gate.",
      "Verify the rollback path still works before completing the switch.",
    ],
  },
  {
    title: "After cutover",
    items: [
      "Keep blue available until the rollback window closes.",
      "Complete the contract step only after old code is drained.",
      "Remove the old schema shape and the idle environment on a planned schedule.",
      "Record the migration steps and the tested recovery path.",
    ],
  },
];

const references = [
  {
    title: "Blue/green deployments",
    url: "https://docs.aws.amazon.com/whitepapers/latest/blue-green-deployments/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Blue-green environments, traffic switching, and the role of shared state.",
  },
  {
    title: "Deployment configurations",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Blue/green and rolling configurations, including traffic shifting options.",
  },
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release verification, rollback, and the limits of a traffic switch.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "blue-green-cutover": {
      model: blueGreenModel,
      presets,
      instructions:
        "Start with Healthy cutover, then apply Destructive migration. Watch the shared database and rollback-blocked signal, not just green errors. Apply Partial cutover to see blue fail before the switch finishes. Run the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Workload, capacity, error rates, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-rolling",
    "deployment-expand-contract",
    "deployment-schema-compat",
    "deployment-rollback-vs-rollforward",
  ],
};
