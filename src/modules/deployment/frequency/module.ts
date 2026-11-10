import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "deploysPerWeek",
    label: "Deploy frequency",
    min: 1,
    max: 70,
    step: 1,
    value: 20,
    unit: "/week",
    group: "Cadence",
    help: "Production deployments per week. Higher frequency usually means smaller batches, if the pipeline can support it.",
    format: "count",
  },
  {
    id: "changeSize",
    label: "Change size",
    min: 1,
    max: 50,
    step: 1,
    value: 4,
    unit: " units",
    group: "Batch",
    help: "Services, components, or migrations changed per deploy. Larger batches increase the number of interactions a single deploy can break.",
    format: "count",
  },
  {
    id: "testCoverage",
    label: "Automated test coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Safety",
    help: "Share of changed behavior covered by tests that run before the deploy. Coverage limits how much of a batch is validated automatically.",
    format: "percent",
  },
  {
    id: "autoRollback",
    label: "Automated rollback (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Safety",
    help: "One means a failing release is rolled back by the deployment system without waiting for a human.",
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
  deploys: number;
  size: number;
  coverage: number;
  rollback: boolean;
  changeFailureRate: number;
  mttrMinutes: number;
  riskScore: number;
}

function compute(p: Params): Values {
  const deploys = Math.max(1, num(p, "deploysPerWeek", 20));
  const size = Math.max(1, num(p, "changeSize", 4));
  const coverage = clamp(num(p, "testCoverage", 85), 0, 100);
  const rollback = num(p, "autoRollback", 1) >= 0.5;

  const changeFailureRate = Math.min(
    60,
    size * 0.15 * (1 - coverage / 200) * (1 + 2 / deploys),
  );
  const mttrMinutes = rollback ? 15 + size * 0.5 : 60 + size * 2;
  const riskScore = clamp(size * (1 + 10 / deploys), 0, 100);

  return { deploys, size, coverage, rollback, changeFailureRate, mttrMinutes, riskScore };
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
  const failureHealth = highHealth(values.changeFailureRate, 3, 10);
  const recoveryHealth = highHealth(values.mttrMinutes, 30, 90);
  const riskHealth = highHealth(values.riskScore, 40, 70);
  const releaseHealth = worst(failureHealth, riskHealth);

  const stageNodes = [
    {
      id: "pipeline",
      label: "Deploy pipeline",
      kind: "worker" as const,
      health: highHealth(values.changeFailureRate, 3, 10),
      utilization: clamp(values.deploys / 70),
      throughput: values.deploys,
      capacity: 70,
      sublabel: `${values.deploys.toFixed(0)} deploys/week · ${values.size.toFixed(0)} units each`,
      detail: `The team deploys ${values.deploys.toFixed(0)} times a week and each deploy changes ${values.size.toFixed(0)} units. Frequency and batch size together determine exposure.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "batch",
      label: "Change batch",
      kind: "service" as const,
      health: releaseHealth,
      utilization: clamp(values.size / 50),
      sublabel: `${values.size.toFixed(0)} units · ${percent(values.changeFailureRate)} failure rate`,
      detail: `A larger batch carries more interacting changes and a wider surface for a failure. Automated coverage is ${percent(values.coverage)}.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "recovery",
      label: "Recovery path",
      kind: "service" as const,
      health: recoveryHealth,
      utilization: clamp(values.mttrMinutes / 180),
      sublabel: values.rollback ? `automatic · ${values.mttrMinutes.toFixed(0)} min` : `manual · ${values.mttrMinutes.toFixed(0)} min`,
      detail: `Recovery takes ${values.mttrMinutes.toFixed(0)} minutes. A fast, tested rollback makes a small deploy cheap to reverse; without it, every deploy is a larger bet.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "commit", label: "Commits", kind: "client" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "pipeline-flow",
      label: "Pipeline",
      kind: "worker" as const,
      health: releaseHealth,
      sublabel: `${values.deploys.toFixed(0)}/week`,
      meta: { view: "flow" },
    },
    {
      id: "prod",
      label: "Production",
      kind: "service" as const,
      health: worst(releaseHealth, recoveryHealth),
      sublabel: `${percent(values.changeFailureRate)} failures`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("commit-pipeline", "commit", "pipeline-flow", clamp(values.deploys / 70), releaseHealth),
      edge("pipeline-prod", "pipeline-flow", "prod", clamp(values.size / 50), worst(releaseHealth, recoveryHealth)),
    ],
    metrics: [
      metric("change-failure-rate", "Change failure rate", values.changeFailureRate, "%", 3, 10, "percent"),
      metric("mttr-minutes", "Recovery time", values.mttrMinutes, "min", 30, 90, "number"),
      metric("change-risk", "Change risk score", values.riskScore, "", 40, 70, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), changeFailureRate: values.changeFailureRate },
    summary: `${values.deploys.toFixed(0)} deploys/week · ${values.size.toFixed(0)} units · ${percent(values.changeFailureRate)} failure rate · ${values.mttrMinutes.toFixed(0)} min recovery`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 5)) / 2.2);
  for (const [id, value] of [
    ["change-failure-rate", values.changeFailureRate],
    ["mttr-minutes", values.mttrMinutes],
    ["change-risk", values.riskScore],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "change-failure-rate",
    metricId: "change-failure-rate",
    warn: 3,
    crit: 10,
    title: "Changes fail too often",
    cause: "Each deploy carries many interacting changes, and automated coverage does not validate enough of the batch. A failure has more places to come from and is harder to attribute.",
    fix: "Reduce the batch size and deploy more often, then improve the test coverage for the changed paths. Frequency without smaller batches only spreads the same risk across more events.",
    checkFirst: [
      "Check the number of services and migrations per deploy.",
      "Check which changed paths had no automated test.",
      "Check whether failures cluster around large batches or specific components.",
    ],
  },
  {
    id: "mttr-minutes",
    metricId: "mttr-minutes",
    warn: 30,
    crit: 90,
    title: "Recovery takes too long",
    cause: "Rollback is manual, the previous artifact is not ready, or the batch is too large to reverse safely. The time to recover turns a small failure into a long incident.",
    fix: "Automate rollback on the health gate, keep the previous artifact available, and test the rollback path. Frequency becomes safer when the cost of reversing a deploy is small.",
    checkFirst: [
      "Check whether the previous artifact and schema support rollback.",
      "Check who must authorize the rollback and how long that takes.",
      "Check the last rollback exercise and its duration.",
    ],
  },
  {
    id: "change-risk",
    metricId: "change-risk",
    warn: 40,
    crit: 70,
    title: "The batch is too large for the cadence",
    cause: "The team deploys infrequently and accumulates many changes between releases. A single deploy then carries the risk of weeks of work and cannot be attributed to one change.",
    fix: "Split the work into smaller, independently deployable changes and increase the cadence. Improve test and rollback capability first if the pipeline cannot support it.",
    checkFirst: [
      "Check how long changes wait before deploy.",
      "Check the number of units changed per release.",
      "Check whether the batch contains unrelated changes that could ship separately.",
    ],
  },
];

export const frequencyModel: SimModel = {
  id: "deployment-frequency",
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
      `The team deploys ${values.deploys.toFixed(0)} times a week with ${values.size.toFixed(0)} units per deploy. Frequency alone does not reduce risk if the batch stays large.`,
    );
    items.push(
      `Change failure rate is ${percent(values.changeFailureRate)} and recovery takes ${values.mttrMinutes.toFixed(0)} minutes. A fast rollback lowers the cost of trying.`,
    );
    items.push(
      `Automated coverage is ${percent(values.coverage)} and rollback is ${values.rollback ? "automated" : "manual"}. The constraint on frequency is often test and rollback capability.`,
    );
    items.push(
      "Small, frequent deploys make each change attributable and reversible. Large, infrequent deploys concentrate risk into one event.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Risky batch", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Thirty small deploys a week, strong coverage, and automatic rollback.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Weekly batch",
    description: "A weekly train with 25 units, moderate coverage, and automatic rollback.",
    tone: "warn",
    params: defaults({ deploysPerWeek: 8, changeSize: 25, testCoverage: 60, autoRollback: 1 }),
  },
  {
    id: "failure",
    label: "Monthly release",
    description: "One large deploy a week, weak coverage, and manual rollback.",
    tone: "crit",
    params: defaults({ deploysPerWeek: 1, changeSize: 40, testCoverage: 40, autoRollback: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Small batches, frequent deploys, strong coverage, and automatic rollback.",
    tone: "ok",
    params: defaults({ deploysPerWeek: 40, changeSize: 2, testCoverage: 95, autoRollback: 1 }),
  },
  {
    id: "weekly-train",
    label: "Weekly train",
    description: "A five-day cadence with 15 units and automatic rollback: better, still a large batch.",
    tone: "warn",
    params: defaults({ deploysPerWeek: 5, changeSize: 15, testCoverage: 75, autoRollback: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-frequency",
  title: "Predict what changes first when deploys are rare and risky",
  simId: "frequency",
  question:
    "The team deploys monthly and every deploy seems to cause an incident. What should change first?",
  prediction: {
    options: [
      { id: "batch", label: "Reduce the batch size and improve rollback so changes can ship more often" },
      { id: "rarer", label: "Deploy even less often to reduce exposure" },
      { id: "approvals", label: "Add more approval steps before each deploy" },
      { id: "tooling", label: "Replace the deployment tool without changing the batch" },
    ],
    correctOptionId: "batch",
    explanation:
      "Monthly deploys accumulate many changes, so each release has a wide surface and no single change is attributable. Smaller batches and a tested rollback make frequent deploys safe. Deploying less often concentrates risk further, and approvals do not reduce the size of the batch.",
  },
  setup: defaults({ deploysPerWeek: 1, changeSize: 40, testCoverage: 40, autoRollback: 0 }),
  runFor: 30,
  observe: [
    "Change failure rate is 14.4%, above the critical threshold.",
    "Recovery time is 140 minutes without automated rollback.",
    "The change risk score is 100 because the batch is large relative to the cadence.",
    "The batch, not the deploy tool, is the constraint.",
  ],
  explain:
    "Deployment frequency is a symptom of batch size and reversibility. A team that can test a small change and roll it back quickly can deploy often. A team that cannot must batch changes, which increases the size of each failure and the time to recover.",
  fix: defaults({ deploysPerWeek: 20, changeSize: 4, testCoverage: 90, autoRollback: 1 }),
  debrief:
    "The fixed state deploys 20 times a week with four units per deploy, 90% coverage, and automatic rollback. The failure rate and recovery time fall below their warning thresholds. The tradeoff is investment in tests and rollback automation before the cadence increases, which is the actual constraint.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Deployment frequency is how often a team releases to production. It matters because frequency and batch size move together. A team that deploys monthly accumulates a month of changes into one event; a team that deploys several times a day ships small, attributable changes. The smaller batch is easier to test, observe, and reverse.",
  },
  {
    type: "p",
    text: "Frequent deploys are not automatically safer. If the pipeline is slow, the tests are weak, or rollback is manual, more deploys just create more opportunities to fail. The useful question is whether the team can make a small change, verify it, and undo it quickly. That capability is what lets frequency reduce risk instead of multiplying it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Frequency sits at the output of the delivery pipeline, alongside lead time, change failure rate, and recovery time. These are commonly called the DORA metrics. The pipeline, test suite, artifact retention, and rollback controller determine what cadence is safe. Leadership and review policy determine whether the team is allowed to use it.",
  },
  {
    type: "p",
    text: "The rates and scores in this model are illustrative. The structural relationship is the lesson: risk rises with batch size and falls with coverage and reversibility. A change in tooling that does not change those three does not change the outcome.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Deploy frequency and change size per release.",
      "Change failure rate: how often a deploy causes a failure.",
      "Recovery time: how long it takes to restore service after a bad deploy.",
      "Change risk score: batch size relative to cadence.",
      "A recovery node showing whether rollback is automatic or manual.",
    ],
  },
  {
    type: "table",
    headers: ["Pattern", "Batch size", "Attribution", "Recovery cost"],
    rows: [
      ["Several small deploys daily", "Small", "One change per deploy", "Low if rollback is ready"],
      ["Weekly release train", "Medium to large", "Many changes per deploy", "Higher"],
      ["Monthly release", "Large", "Hard to isolate", "High"],
      ["Emergency-only deploys", "Unbounded", "Unknown", "Very high"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Monthly release. Compare change failure rate, recovery time, and risk score. Apply Weekly train to see a partial improvement. Apply Recovery, then run the experiment and its fix. Note that the fix changes batch size and rollback before it changes cadence.",
  },
  { type: "sim", simId: "frequency" },
  { type: "experiment", experimentId: "predict-frequency" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, one deploy a week carried 40 units of change with 40% coverage and no automated rollback. The change failure rate reached 14.4%, recovery took 140 minutes, and the risk score reached 100. The batch was large, the safety net was thin, and every deploy was a bet.",
  },
  {
    type: "p",
    text: "The weekly-train preset improved but did not solve the problem: 15 units per deploy still produced a risk score of 45. Frequency without smaller batches and better recovery moves the same risk around; it does not remove it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A release with dozens of unrelated changes and no clear rollback point.",
      "Incident reviews that cannot identify which change caused the failure.",
      "Long recovery because rollback is manual or the previous artifact is gone.",
      "Test suites that pass but do not cover the changed paths.",
      "Deploy windows that grow longer as the batch grows.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the number of changes per deploy and how long they waited. Check whether the failure rate falls when the batch gets smaller. Check rollback time and whether the previous artifact is available. Check test coverage for the paths that changed, not the whole repository.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Split the release into independently deployable changes.",
      "Automate rollback on a health or error gate.",
      "Keep the previous artifact and test the rollback path.",
      "Increase test coverage for the paths that change most often.",
      "Raise the cadence after the safety net is in place.",
      "Measure failure rate and recovery time, not just deploy count.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Frequent small deploys improve attribution and recovery but require pipeline and test investment.",
      "Larger batches reduce deployment overhead but increase failure size and recovery time.",
      "More approvals may feel safer but add lead time and do not reduce batch risk.",
      "Automatic rollback is fast but can revert a change that is actually helping if the gate is poorly designed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "monthly",
    question:
      "A team deploys monthly and every deploy is an incident. Where do you start?",
    difficulty: 2,
    hints: [
      "Look at batch size, not just cadence.",
      "Check rollback and test capability.",
      "Do not start with tooling.",
    ],
    answer:
      "I would measure batch size, change failure rate, recovery time, and test coverage before changing the cadence. Monthly deploys usually mean a large batch and a slow, manual rollback. I would split the work into smaller changes, automate rollback, and improve coverage for the paths that fail. Once a small deploy can be tested and reversed quickly, increasing frequency reduces risk rather than adding it.",
    followUps: [
      "What if leadership requires monthly releases?",
      "Which metric would you use to prove the change worked?",
      "What is the first batch you would split?",
    ],
    redFlags: ["Starts with a new deploy tool.", "Adds approvals.", "Increases frequency without rollback."],
    rubric: ["Measures batch and recovery.", "Splits changes.", "Improves tests and rollback.", "Raises cadence after safety."],
  },
  {
    id: "dora",
    question: "Why do deployment frequency and change failure rate belong together?",
    difficulty: 2,
    hints: [
      "Frequency alone is not a goal.",
      "Batch size connects them.",
      "Recovery is the other half.",
    ],
    answer:
      "Frequency measures how often change reaches production; change failure rate measures how often that change causes a failure. A team can deploy constantly and break constantly, or deploy rarely and still break. The useful combination is frequent, small changes with a low failure rate and fast recovery. Batch size connects the two, and recovery determines the cost when a change fails.",
    followUps: [
      "Which metric would you optimize first?",
      "How can frequency hide a quality problem?",
      "How does lead time fit in?",
    ],
    redFlags: ["Treats frequency as the only goal.", "Ignores recovery.", "Optimizes a single metric."],
    rubric: ["Pairs frequency with failure rate.", "Explains batch size.", "Includes recovery.", "Avoids single-metric optimization."],
  },
  {
    id: "rollback",
    question: "What makes automated rollback a prerequisite for higher deploy frequency?",
    difficulty: 3,
    hints: [
      "More attempts mean more chances to fail.",
      "Recovery cost limits how often you can try.",
      "The gate has to be trustworthy.",
    ],
    answer:
      "More frequent deploys mean more attempts, so the cost of a failed attempt has to be small. Automated rollback detects a failing health or error signal and restores the previous artifact without waiting for a human. That bounds user impact and makes the next deploy less risky. The gate must be designed carefully, because an automatic rollback can also revert a change that is working but temporarily shifts a metric.",
    followUps: [
      "Which signals would trigger automatic rollback?",
      "How do you avoid false triggers?",
      "What if the previous artifact is incompatible with new data?",
    ],
    redFlags: ["Assumes rollback is always safe.", "Has no gate design.", "Waits for a human."],
    rubric: ["Links frequency to recovery cost.", "Describes automatic detection.", "Bounds impact.", "Notes false-trigger risk."],
  },
  {
    id: "batch-split",
    question: "How would you split a large monthly release into smaller deploys?",
    difficulty: 3,
    hints: [
      "Find independent changes.",
      "Use flags for incomplete features.",
      "Keep schema and config compatible.",
    ],
    answer:
      "I would inventory the release and separate independent changes from those that must ship together. Incomplete features can go behind flags. Schema changes use expand/contract so they ship separately from the code that uses them. Shared libraries are versioned and rolled out independently. The goal is a sequence of small, reversible deploys, each with its own verification and rollback point.",
    followUps: [
      "What would you do with a hard dependency between two changes?",
      "How do flags affect the batch size?",
      "How do you keep the release coherent for users?",
    ],
    redFlags: ["Splits arbitrarily.", "Ignores schema compatibility.", "Ships incomplete features without flags."],
    rubric: ["Finds independent changes.", "Uses flags.", "Sequences schema.", "Keeps each deploy reversible."],
  },
];

const checklist = [
  {
    title: "Before increasing frequency",
    items: [
      "Measure batch size, change failure rate, and recovery time.",
      "Automate rollback on a trusted health or error gate.",
      "Confirm the previous artifact and schema support rollback.",
      "Improve coverage for the paths that change most often.",
      "Split the next release into independently deployable changes.",
    ],
  },
  {
    title: "During the transition",
    items: [
      "Increase cadence gradually and watch failure rate.",
      "Keep batch size small as frequency rises.",
      "Check that each deploy has a clear owner and rollback point.",
      "Stop and fix the safety net if recovery time rises.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Compare failure rate and recovery time with the previous cadence.",
      "Review whether large batches are reappearing.",
      "Keep rollback drills part of the release routine.",
      "Report frequency with its quality and recovery metrics.",
    ],
  },
];

const references = [
  {
    title: "DORA metrics: the four keys",
    url: "https://dora.dev/guides/dora-metrics-four-keys/",
    publisher: "DORA",
    kind: "docs" as const,
    note: "Deployment frequency, lead time, change failure rate, and recovery time.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Small releases, rollback, and the relationship between change size and risk.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    frequency: {
      model: frequencyModel,
      presets,
      instructions:
        "Start with Healthy, then apply Monthly release. Compare failure rate, recovery time, and risk. Apply Weekly train to see a partial improvement. Apply Recovery, then run the experiment and its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Frequencies, batch sizes, and scores are teaching values, not DORA benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-cicd", "deployment-lead-time", "deployment-rolling", "deployment-automated-rollback"],
};
