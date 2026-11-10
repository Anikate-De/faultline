import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "detectionMinutes",
    label: "Detect and decide",
    min: 1,
    max: 30,
    step: 1,
    value: 2,
    unit: " min",
    group: "Drill steps",
    help: "From the first signal to a human decision to invoke the DR plan. Alerts that nobody owns extend this step.",
    format: "number" as const,
  },
  {
    id: "restoreMinutes",
    label: "Restore database",
    min: 5,
    max: 120,
    step: 1,
    value: 7,
    unit: " min",
    group: "Drill steps",
    help: "Provision, copy the base backup, replay logs to the target, and validate the database. Illustrative measured value.",
    format: "number" as const,
  },
  {
    id: "dnsTtlSeconds",
    label: "DNS TTL",
    min: 1,
    max: 300,
    step: 1,
    value: 30,
    unit: " s",
    group: "Cutover",
    help: "How long a client or resolver may keep the old writer address. The cutover step includes one TTL of stale resolution.",
    format: "number" as const,
  },
  {
    id: "warmupMinutes",
    label: "Application warmup",
    min: 1,
    max: 60,
    step: 1,
    value: 2,
    unit: " min",
    group: "Cutover",
    help: "Time to start tasks, fill connection pools, warm caches, and pass smoke tests after the database is available.",
    format: "number" as const,
  },
  {
    id: "replicaLagSeconds",
    label: "Replica lag at cutover",
    min: 0,
    max: 600,
    step: 5,
    value: 5,
    unit: " s",
    group: "Data",
    help: "Data loss the drill actually exposes when the standby is promoted. This is the achieved RPO, not the planned one.",
    format: "number" as const,
  },
  {
    id: "dependencyKnown",
    label: "Dependency in runbook",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Readiness",
    help: "1 means every dependency is listed and verified. 0 models a forgotten dependency that adds 20 minutes of discovery to application readiness.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function status(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Stage {
  id: string;
  label: string;
  kind: "worker" | "db" | "service";
  minutes: number;
  detail: string;
}

interface Computed {
  detection: number;
  restore: number;
  dnsMinutes: number;
  warmup: number;
  dependencyKnown: boolean;
  appMinutes: number;
  rto: number;
  rpo: number;
  readinessGap: number;
  overall: Health;
  stages: Stage[];
  bottleneck: string;
}

function compute(p: Params): Computed {
  const detection = clamp(num(p, "detectionMinutes", 2), 1, 30);
  const restore = clamp(num(p, "restoreMinutes", 7), 5, 120);
  const dnsMinutes = clamp(num(p, "dnsTtlSeconds", 30), 1, 300) / 60;
  const warmup = clamp(num(p, "warmupMinutes", 2), 1, 60);
  const dependencyKnown = num(p, "dependencyKnown", 1) >= 0.5;
  const appMinutes = warmup + (dependencyKnown ? 0 : 20);
  const rto = detection + restore + dnsMinutes + appMinutes;
  const rpo = clamp(num(p, "replicaLagSeconds", 5), 0, 600);
  const readinessGap = dependencyKnown ? 0 : 40;
  const overall = status(rto, 12, 15);
  const stages: Stage[] = [
    {
      id: "detect",
      label: "Detect and decide",
      kind: "worker",
      minutes: detection,
      detail: "Signal, acknowledgment, and the decision to invoke the plan.",
    },
    {
      id: "restore",
      label: "Restore database",
      kind: "db",
      minutes: restore,
      detail: "Provision, copy the base backup, replay logs, and validate.",
    },
    {
      id: "dns",
      label: "DNS cutover",
      kind: "service",
      minutes: dnsMinutes,
      detail: "Change the writer endpoint and wait out the TTL at clients and resolvers.",
    },
    {
      id: "app",
      label: "Application verify",
      kind: "service",
      minutes: appMinutes,
      detail: dependencyKnown
        ? "Start tasks, fill pools, warm caches, and pass smoke tests."
        : "Start tasks, discover the missing dependency, then fix and retry before smoke tests pass.",
    },
  ];
  const bottleneck = stages.reduce((worst, stage) => (stage.minutes > worst.minutes ? stage : worst)).id;
  return {
    detection,
    restore,
    dnsMinutes,
    warmup,
    dependencyKnown,
    appMinutes,
    rto,
    rpo,
    readinessGap,
    overall,
    stages,
    bottleneck,
  };
}

function stageHealth(values: Computed, stage: Stage): Health {
  if (stage.id === "app" && values.readinessGap >= 25) return "crit";
  if (stage.id === "app" && values.readinessGap >= 10) return "warn";
  if (values.overall === "ok") return "ok";
  if (values.overall === "warn") return stage.id === values.bottleneck ? "warn" : "ok";
  return stage.id === values.bottleneck ? "crit" : "warn";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["measured-rto", values.rto, 0.15],
    ["achieved-rpo", values.rpo, 0.5],
    ["readiness-gap", values.readinessGap, 0.5],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: values.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      kind: stage.kind,
      health: stageHealth(values, stage),
      utilization: clamp(stage.minutes / Math.max(values.rto, 1)),
      sublabel: `${stage.minutes.toFixed(stage.minutes < 10 ? 1 : 0)} min`,
      detail: stage.detail,
      meta: { minutes: Number(stage.minutes.toFixed(2)) },
    })),
    edges: values.stages.slice(1).map((stage, index) =>
      edge(
        `step-${stage.id}`,
        values.stages[index].id,
        stage.id,
        clamp(stage.minutes / Math.max(values.rto, 1)),
        stageHealth(values, stage),
        "elapsed time",
      ),
    ),
    metrics: [
      metric("measured-rto", "Measured RTO", values.rto, " min", 12, 15, "number"),
      metric("achieved-rpo", "Achieved RPO", values.rpo, " s", 30, 120, "number"),
      metric("readiness-gap", "Readiness gap", values.readinessGap, "%", 10, 25, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Measured RTO ${values.rto.toFixed(
      1,
    )} min against a 15-minute target. Achieved RPO ${formatCount(values.rpo)}s. Readiness gap ${
      values.readinessGap
    }%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rto",
    metricId: "measured-rto",
    warn: 12,
    crit: 15,
    title: "Drill misses the RTO target",
    cause:
      "Measured RTO is the sum of every step between the first signal and verified service, not the database restore alone. Detection, DNS time to live (TTL), and application readiness commonly dominate.",
    fix:
      "Measure each step separately, automate detection and cutover, lower DNS TTL ahead of time, pre-warm pools and tasks, and remove dependencies that the runbook forgot.",
    checkFirst: [
      "Compare the measured total with the planned 15-minute target.",
      "Identify the longest step; that is where the next improvement pays.",
      "Check whether the clock starts at the user-visible failure or at the database alert.",
    ],
  },
  {
    id: "rpo",
    metricId: "achieved-rpo",
    warn: 30,
    crit: 120,
    title: "Achieved RPO is wider than planned",
    cause:
      "The standby was behind when the drill cut over, or the restore used an older backup. The data-loss window is the distance between the promoted point and the last committed write.",
    fix:
      "Record lag at the decision point, choose the least-lagged target, and treat lag as a drill input. If the target is a backup, include its age in the reported RPO.",
    checkFirst: [
      "Record replication lag at the moment of cutover, not after.",
      "Compare the promoted point with the last acknowledged write.",
      "Check whether the application logged writes that the database lost.",
    ],
  },
  {
    id: "readiness",
    metricId: "readiness-gap",
    warn: 10,
    crit: 25,
    title: "Application readiness was not verified",
    cause:
      "The database restored, but a dependency, credential, queue, or cache was missing from the runbook. The service is not recovered until it can serve traffic, not when the database accepts connections.",
    fix:
      "Add every runtime dependency to the runbook, verify it in the drill, and gate cutover on end-to-end smoke tests rather than database availability.",
    checkFirst: [
      "List the dependencies the application needs at startup, not just the database endpoint.",
      "Check secrets, certificates, DNS, queues, and external services in the restored environment.",
      "Run the smoke test through the real entry point, not directly against the database.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const drillModel: SimModel = {
  id: "databases-dr-drills",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, values, seed);
    pushEvent(frame, {
      id: "drill-ready",
      at: 0,
      severity: "info",
      title: "Drill scenario loaded",
      detail: "Apply a preset or change a step to see how the measured RTO and RPO move.",
      nodeId: "detect",
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
    }
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.overall !== "ok" && frame.flags.statusLogged !== values.overall) {
      pushEvent(next, {
        id: `drill-${values.overall}`,
        severity: values.overall === "crit" ? "crit" : "warn",
        title: values.overall === "crit" ? "Drill misses the recovery target" : "Drill is close to the target",
        detail: `Measured ${values.rto.toFixed(1)} min. The largest step is ${
          values.stages.find((stage) => stage.id === values.bottleneck)?.label ?? "unknown"
        }; achieved RPO is ${formatCount(values.rpo)}s.`,
        nodeId: values.bottleneck,
        metricId: "measured-rto",
      });
    }
    if (!values.dependencyKnown && frame.flags.dependencyLogged !== 1) {
      pushEvent(next, {
        id: "dependency-gap",
        severity: "crit",
        title: "A dependency was missing from the runbook",
        detail: "The database is available but the application cannot serve traffic. The drill clock keeps running until the dependency is found and fixed.",
        nodeId: "app",
        metricId: "readiness-gap",
      });
    }
    next.flags = {
      ...frame.flags,
      ...next.flags,
      statusLogged: values.overall,
      dependencyLogged: values.dependencyKnown ? 0 : 1,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const longest = values.stages.find((stage) => stage.id === values.bottleneck);
    const items: string[] = [
      `Measured RTO is ${values.rto.toFixed(1)} min. The longest step is ${
        longest?.label ?? "unknown"
      } at ${longest?.minutes.toFixed(1)} min.`,
      `Achieved RPO is ${formatCount(values.rpo)}s; that is a measured data-loss window, not the plan's target.`,
      "The drill clock runs until the service passes a real request, not until the database accepts connections.",
    ];
    if (!values.dependencyKnown) {
      items.push(
        "The 20-minute readiness penalty represents discovering and fixing a dependency the runbook never listed. It is an illustrative value, not a universal cost.",
      );
    }
    items.push(
      "A drill that only tests the database restore leaves DNS, pools, secrets, and application startup unmeasured.",
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
    label: "Healthy drill",
    description: "Every step is short, the standby is 5 seconds behind, and the dependency list is complete.",
    tone: "ok",
    params: defaults({ detectionMinutes: 2, restoreMinutes: 6, dnsTtlSeconds: 30, warmupMinutes: 2 }),
  },
  {
    id: "peak",
    label: "Near the target",
    description: "A 30-second TTL and three minutes of warmup push the measured RTO close to 15 minutes.",
    tone: "warn",
    params: defaults({
      detectionMinutes: 2,
      restoreMinutes: 8,
      dnsTtlSeconds: 30,
      warmupMinutes: 3,
      replicaLagSeconds: 45,
    }),
  },
  {
    id: "failure",
    label: "Forgotten dependency",
    description: "The restore takes 60 minutes, DNS adds five, and a missing dependency adds 20 more before the app serves.",
    tone: "crit",
    params: defaults({
      detectionMinutes: 12,
      restoreMinutes: 60,
      dnsTtlSeconds: 300,
      warmupMinutes: 30,
      replicaLagSeconds: 300,
      dependencyKnown: 0,
    }),
  },
  {
    id: "database-only",
    label: "Database-only drill",
    description: "The restore is fast, but the application cannot start without the missing dependency.",
    tone: "crit",
    params: defaults({
      detectionMinutes: 2,
      restoreMinutes: 8,
      dnsTtlSeconds: 30,
      warmupMinutes: 5,
      replicaLagSeconds: 45,
      dependencyKnown: 0,
    }),
  },
  {
    id: "recovery",
    label: "Passing drill",
    description: "Measured RTO is 11.5 minutes, the standby is 10 seconds behind, and readiness is verified.",
    tone: "ok",
    params: defaults({ detectionMinutes: 2, restoreMinutes: 7, dnsTtlSeconds: 30, warmupMinutes: 2, replicaLagSeconds: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-missing-step",
  title: "Predict why the service missed the plan",
  simId: "dr-drills",
  question:
    "Detection takes 2 minutes, the database restore takes 8, and DNS TTL adds 1. The plan says 15 minutes RTO. The service starts serving at 23 minutes. Which step was unplanned?",
  prediction: {
    options: [
      { id: "restore", label: "The database restore exceeded its estimate." },
      { id: "dns", label: "DNS TTL dominated the cutover." },
      { id: "app", label: "Application warmup after the database was available." },
      { id: "rpo", label: "Replication lag added the missing minutes." },
    ],
    correctOptionId: "app",
    explanation:
      "The database, detection, and DNS steps add about 11 minutes. The remaining 12 minutes are application warmup: starting tasks, filling pools, warming caches, and passing smoke tests. Replication lag affects data loss, not the time to serve traffic. The plan measured the database, not the service.",
  },
  setup: defaults({
    detectionMinutes: 2,
    restoreMinutes: 8,
    dnsTtlSeconds: 60,
    warmupMinutes: 12,
    replicaLagSeconds: 10,
    dependencyKnown: 1,
  }),
  runFor: 20,
  observe: [
    "Measured RTO is 23 minutes and crosses the critical threshold.",
    "Achieved RPO stays at 10 seconds, well inside the data target.",
    "Application verify is the longest step and carries the critical state.",
    "The database restore node is healthy; the service is not.",
    "Readiness gap stays at zero because the dependency is known, but warmup itself is long enough to miss RTO.",
  ],
  explain:
    "An RTO measured at the database boundary hides every step after it. The application must start, connect, warm, and pass a real request before the service is recovered. A drill that stops at 'database available' reports a shorter, wrong number.",
  fix: defaults({
    detectionMinutes: 1,
    restoreMinutes: 8,
    dnsTtlSeconds: 60,
    warmupMinutes: 1,
    replicaLagSeconds: 10,
    dependencyKnown: 1,
  }),
  debrief:
    "With detection at 1 minute and warmup at 1, the same restore lands at 11 minutes. The database timing did not change. The drill exposed that warmup and detection, not the restore, were consuming the RTO budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A disaster recovery (DR) drill is a timed exercise that executes the recovery plan far enough to prove the numbers in it. A plan that claims a 15-minute recovery time objective (RTO) is a hypothesis until someone measures detection, restore, cutover, and application readiness end to end. A plan that claims a 5-minute recovery point objective (RPO) is a hypothesis until someone measures the data that was actually missing.",
  },
  {
    type: "p",
    text: "Drills are not only failover tests. A useful drill records when the first signal arrived, when a human decided to invoke the plan, when the database was available, when DNS moved, and when the service passed a real request. Those timestamps turn one vague RTO into five numbers with owners. A game day is the broader exercise that can include drills, decision-making, and communication practice.",
  },
  {
    type: "p",
    text: "The most common finding is not a slow database restore. It is an unmeasured step: a dependency missing from the runbook, a DNS TTL that keeps clients on the old writer, a connection pool that reconnects in a storm, or a secret that exists only in the failed Region. The database can be healthy while the service is still down.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The DR plan defines targets and strategies. The runbook defines the steps and owners. The drill executes the runbook against a realistic failure and produces evidence. The evidence feeds back into the plan, the alerts, and the capacity reservations. Without the drill, the plan and the runbook are documents that have never met production.",
  },
  {
    type: "compare",
    leftTitle: "Tabletop exercise",
    rightTitle: "Full failover drill",
    rows: [
      { label: "What moves", left: "Discussion and decisions", right: "Real traffic and infrastructure" },
      { label: "Measures", left: "Understanding and ownership", right: "RTO, RPO, and readiness" },
      { label: "Risk", left: "Low", right: "Needs a blast-radius plan" },
      { label: "Finds", left: "Missing roles and unknowns", right: "Missing dependencies and timing" },
    ],
  },
  {
    type: "p",
    text: "A drill needs a blast-radius plan: which traffic moves, which customers are affected, how to abort, and who can authorize the abort. Testing in a separate Region or account reduces risk but can miss quotas, DNS, and network paths that only exist in production. The useful compromise is usually a staged drill: validate the restore in isolation, validate the cutover with a small traffic slice, then measure the full path when the abort is proven.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Measured RTO: the sum of every step from signal to verified service, compared with the plan.",
      "Achieved RPO: the data-loss window observed at cutover, not the target in the document.",
      "Readiness gap: the share of the service that is still unavailable after the database is up.",
      "Per-step time: detection, restore, DNS cutover, and application verification, each with an owner.",
      "Bottleneck node: the step that consumes the largest part of the measured RTO.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the measured RTO. Apply Forgotten dependency and find which node carries the critical state before reading the number. Then compare Database-only drill with a passing preset: the database step is identical, but readiness changes the outcome. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The 15-minute target, the 20-minute dependency penalty, and the thresholds are illustrative teaching values. Your targets come from the business and your timings from a measured drill.",
  },
  { type: "sim", simId: "dr-drills" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, detection took 12 minutes, the restore 60, DNS 5, and application readiness 50 because a dependency was missing. The measured RTO was 127 minutes against a 15-minute plan. The restore was the largest single step, but the missing dependency still added 20 minutes after the database was ready.",
  },
  {
    type: "p",
    text: "The database-only preset made the split clearer. The restore finished in 8 minutes, but the service still missed the target because the application could not start. A drill that stopped when the database accepted connections would have reported success and taught the wrong lesson.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Timestamps for first signal, acknowledgment, decision, database available, DNS change, and first successful user request.",
      "Replication lag at the decision point, and the last write the promoted database contains.",
      "DNS TTL and resolver behavior; clients with cached addresses keep writing to the old endpoint.",
      "Application startup logs: missing secrets, failed queue connections, pool timeouts, and cache warmup.",
      "Error rate and latency after cutover, which show whether the service is actually recovered.",
      "Drill artifacts: who approved the abort, what traffic moved, and which checks were skipped.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Put every step on one clock and compare the total with the plan. Then find the longest step and the first step that was not in the runbook. If the database was available before the service, the remaining gap is readiness, not recovery.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the drill timeline before changing anything: signal, decision, restore, cutover, verification.",
      "Measure each step with the same clock and record who owns it.",
      "Add every runtime dependency to the runbook and verify it in the restored environment.",
      "Lower DNS TTLs ahead of the drill and confirm clients honor them; do not change TTL during the incident.",
      "Pre-warm pools, tasks, and caches, and gate cutover on an end-to-end smoke test.",
      "Reserve capacity in the DR Region for the full active load, not just for the database.",
      "Debrief with owners and due dates, then re-run the drill to prove the fix.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A full production drill gives the most credible numbers but carries real customer risk and needs an abort path.",
      "An isolated drill is safer but can miss quotas, DNS, and network dependencies that only exist in production.",
      "Shorter DNS TTLs speed cutover but increase query volume and resolver load every day.",
      "Keeping a warm standby improves RTO but costs capacity that sits idle most of the time.",
      "Automating cutover reduces human delay but can move traffic before validation if the gates are weak.",
      "Drilling often finds problems; drilling rarely keeps the runbook and the team's muscle memory stale.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "measure-rto",
    question: "How do you measure RTO for a database-backed service?",
    difficulty: 3,
    hints: [
      "Start at the user-visible signal, not the database alert.",
      "Stop at a verified request, not at database availability.",
    ],
    answer:
      "I would define the start as the first user-visible failure or the first actionable signal, and the end as the first verified successful request through the normal entry point. In between I would timestamp detection, acknowledgment, the decision to invoke the plan, database availability, DNS cutover, application startup, and smoke-test pass. The measured RTO is the end minus the start, and the per-step numbers show where it went. I would run the drill with the real runbook and real access paths, otherwise I am measuring a different procedure.",
    followUps: [
      "What if the first signal is delayed by monitoring?",
      "How do you measure RTO without moving production traffic?",
      "Which step would you optimize first?",
    ],
    redFlags: [
      "Measures only the database restore.",
      "Starts the clock at the incident channel creation.",
      "Reports the planned target as the measured result.",
    ],
    rubric: [
      "Defines start and end from the user's perspective.",
      "Breaks RTO into owned steps.",
      "Includes DNS and application readiness.",
      "Uses a real drill, not a estimate.",
    ],
  },
  {
    id: "drill-safety",
    question: "How do you run a DR drill without causing the incident you are preparing for?",
    difficulty: 3,
    hints: [
      "Bound the blast radius before moving traffic.",
      "Prove the abort path first.",
    ],
    answer:
      "I would start with a restore in an isolated account or Region, then move a small traffic slice with a pre-agreed abort condition and a named person who can trigger it. I would freeze schema changes during the drill, reserve capacity, and keep the old path available until the new one passes smoke tests. I would also rehearse the abort itself before the drill. If the abort is not proven, the drill is a production change with an unknown rollback.",
    followUps: [
      "What traffic percentage would you move first?",
      "How do you keep the drill from corrupting data?",
      "Who can abort, and how quickly?",
    ],
    redFlags: [
      "Moves all traffic to prove the plan.",
      "Has no abort criteria.",
      "Runs during a change freeze without approval.",
    ],
    rubric: [
      "Starts isolated and increases blast radius.",
      "Defines abort conditions and authority.",
      "Reserves capacity and freezes schema changes.",
      "Validates with smoke tests before full cutover.",
    ],
  },
  {
    id: "drill-findings",
    question: "The drill misses RTO because of a dependency nobody listed. What do you change?",
    difficulty: 2,
    hints: [
      "Fix the runbook and the verification, not just the one dependency.",
      "A finding without an owner and a re-test is not fixed.",
    ],
    answer:
      "I would add the dependency to the runbook with an owner and a verification step, then change the cutover gate so the service cannot be declared recovered until an end-to-end request passes. I would also look for the same class of dependency elsewhere: secrets, certificates, queues, caches, and external APIs. Finally I would re-run the drill and confirm the measured RTO with the fix in place. Adding the dependency without re-testing leaves the new runbook unproven.",
    followUps: [
      "How do you find dependencies nobody documented?",
      "What belongs in the smoke test?",
      "How often should the drill repeat?",
    ],
    redFlags: [
      "Adds the dependency to a wiki page and stops.",
      "Blames the team without changing the gate.",
      "Declares success from a tabletop review.",
    ],
    rubric: [
      "Adds an owner and verification step.",
      "Gates cutover on an end-to-end check.",
      "Searches for the same dependency class.",
      "Re-runs the drill to prove the fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the drill",
    items: [
      "The plan states RTO and RPO per service and data class, with an owner.",
      "The runbook lists every dependency, secret, and endpoint needed at startup.",
      "The abort path and the person authorized to use it are agreed in advance.",
      "Capacity is reserved in the DR Region for the full active load.",
      "The drill uses the same access paths and tooling as a real incident.",
      "A communication plan covers customers, support, and internal responders.",
    ],
  },
  {
    title: "During the drill",
    items: [
      "Timestamp first signal, decision, database available, DNS cutover, and first verified request.",
      "Record replication lag at the moment of cutover.",
      "Move traffic in bounded steps and watch error rate and latency.",
      "Note every step that was missing from the runbook.",
      "Abort if the agreed condition is met; the drill is not worth a real outage.",
    ],
  },
  {
    title: "After the drill",
    items: [
      "Report measured RTO and RPO, not the planned targets.",
      "Assign an owner and due date to every gap.",
      "Update the runbook, alerts, DNS TTLs, and capacity reservations.",
      "Re-run the drill after the fixes and compare the new timeline.",
    ],
  },
];

const references = [
  {
    title: "Disaster Recovery of Workloads on AWS",
    url: "https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "RTO and RPO definitions, DR strategies, and the need to test recovery.",
  },
  {
    title: "Google SRE Workbook",
    url: "https://sre.google/workbook/",
    publisher: "Google",
    kind: "book" as const,
    note: "Exercises, game days, and validating recovery procedures before an incident.",
  },
  {
    title: "Amazon RDS: Multi-AZ DB instance deployments",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed failover behavior and the writer endpoint used during cutover.",
  },
  {
    title: "PostgreSQL: High Availability, Load Balancing, and Replication",
    url: "https://www.postgresql.org/docs/current/high-availability.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Failover roles and the difference between a standby promotion and a tested recovery.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "dr-drills": {
      model: drillModel,
      presets,
      instructions:
        "Start Healthy, apply Forgotten dependency, then compare Database-only drill with a passing drill. Watch which step carries the critical state.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 15-minute target and 20-minute dependency penalty are teaching values, not benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-cross-region-rpo",
    "databases-backups-pitr",
    "databases-multi-az-vs-region",
    "reliability-game-days",
    "reliability-runbooks",
  ],
};
