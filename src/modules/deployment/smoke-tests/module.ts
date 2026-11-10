import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 6_000;

const params: ParamSpec[] = [
  {
    id: "criticalPathCoverage",
    label: "Critical-path coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Smoke suite",
    help: "Share of revenue or safety-critical user paths the smoke suite actually calls, such as checkout.",
    format: "percent",
  },
  {
    id: "realDependencyCoverage",
    label: "Real-dependency coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Smoke suite",
    help: "Share of smoke calls that use the real dependency client, credentials, and network path instead of a mock.",
    format: "percent",
  },
  {
    id: "writeReadbackCoverage",
    label: "Write read-back coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Smoke suite",
    help: "Share of smoke tests that perform a write and read it back through the same path a user or consumer uses.",
    format: "percent",
  },
  {
    id: "trafficExposedPercent",
    label: "Traffic if the suite passes",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Release",
    help: "Share of production traffic moved to the new version when the smoke suite reports a pass. A caught defect blocks the shift.",
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
  pathCoverage: number;
  dependencyCoverage: number;
  writeCoverage: number;
  pathGap: number;
  dependencyGap: number;
  writeGap: number;
  coverageGap: number;
  detected: boolean;
  traffic: number;
  pathError: number;
  dependencyError: number;
  writeError: number;
  totalError: number;
  escaped: number;
  falsePassRate: number;
  p99: number;
}

function compute(p: Params): Values {
  const pathCoverage = clamp(num(p, "criticalPathCoverage", 100), 0, 100);
  const dependencyCoverage = clamp(num(p, "realDependencyCoverage", 100), 0, 100);
  const writeCoverage = clamp(num(p, "writeReadbackCoverage", 100), 0, 100);
  const exposed = clamp(num(p, "trafficExposedPercent", 100), 0, 100);
  const pathGap = 100 - pathCoverage;
  const dependencyGap = 100 - dependencyCoverage;
  const writeGap = 100 - writeCoverage;
  const coverageGap = (pathGap + dependencyGap + writeGap) / 3;
  const detected = pathCoverage >= 70 && dependencyCoverage >= 70 && writeCoverage >= 70;
  const traffic = detected ? 0 : exposed;
  const share = traffic / 100;
  const pathError = (pathGap / 100) * share * 12;
  const dependencyError = (dependencyGap / 100) * share * 20;
  const writeError = (writeGap / 100) * share * 8;
  const totalError = pathError + dependencyError + writeError;
  const escaped = detected ? 0 : [pathGap > 0, dependencyGap > 0, writeGap > 0].filter(Boolean).length;
  const falsePassRate = detected ? 0 : (escaped / 3) * 100;
  const p99 = 90 + totalError * 22 + coverageGap * 0.8;

  return {
    pathCoverage,
    dependencyCoverage,
    writeCoverage,
    pathGap,
    dependencyGap,
    writeGap,
    coverageGap,
    detected,
    traffic,
    pathError,
    dependencyError,
    writeError,
    totalError,
    escaped,
    falsePassRate,
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

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const pathHealth = errorHealth(values.pathError, 0.5, 2);
  const dependencyHealth = errorHealth(values.dependencyError, 0.5, 2);
  const writeHealth = errorHealth(values.writeError, 0.5, 2);
  const trafficHealth = errorHealth(values.totalError, 1, 3);
  const suiteHealth: Health =
    values.detected ? "ok" : values.totalError >= 3 ? "crit" : values.escaped > 0 ? "warn" : "ok";
  const overall = worst(pathHealth, dependencyHealth, writeHealth, trafficHealth, suiteHealth);

  const stageNodes = [
    {
      id: "task",
      label: "New task",
      kind: "service" as const,
      health: "ok" as const,
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: "started and stable",
      detail: "The container starts and stays running. This is necessary, but it is not evidence that checkout can complete.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "health-check",
      label: "Health probe",
      kind: "service" as const,
      health: "ok" as const,
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: "returns 200",
      detail: "The probe checks the process and maybe a local dependency. It does not authenticate to payment or write an order.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "smoke-suite",
      label: values.detected ? "Smoke suite fails" : "Smoke suite passes",
      kind: "service" as const,
      health: suiteHealth,
      utilization: clamp(values.coverageGap / 100),
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: `${values.escaped} escaped · false pass ${percent(values.falsePassRate)}`,
      detail: values.detected
        ? "The suite called checkout through the real dependency and read the order back. It failed, so promotion stops."
        : "The suite is green because it never exercised the broken outcome. A green suite is not a working checkout path.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "traffic",
      label: "Production traffic",
      kind: "service" as const,
      health: trafficHealth,
      utilization: clamp(values.traffic / 100),
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.traffic)} traffic · errors ${percent(values.totalError)}`,
      detail:
        values.traffic > 0
          ? `The new version serves ${Math.round((values.traffic / 100) * TOTAL_RPS).toLocaleString()} rps. Checkout errors are ${percent(values.pathError)}.`
          : "The suite failed before promotion. The stable version continues to serve.",
      meta: { stage: "full", view: "deployment" },
    },
    {
      id: "payment",
      label: "Payment dependency",
      kind: "external" as const,
      health: dependencyHealth,
      utilization: 0.55,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `errors ${percent(values.dependencyError)}`,
      detail: "A mocked payment call proves the mock works. It does not prove credentials, timeout behavior, or the live contract.",
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
      id: "checkout",
      label: "Checkout",
      kind: "service" as const,
      health: worst(pathHealth, trafficHealth),
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `errors ${percent(values.pathError)}`,
      meta: { view: "flow" },
    },
    {
      id: "payment-flow",
      label: "Payment",
      kind: "external" as const,
      health: dependencyHealth,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: "real dependency",
      meta: { view: "flow" },
    },
    {
      id: "orders",
      label: "Orders",
      kind: "db" as const,
      health: writeHealth,
      utilization: 0.6,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `write failures ${percent(values.writeError)}`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-checkout", "clients", "checkout", 1, overall),
      edge("checkout-payment", "checkout", "payment-flow", values.traffic / 100, dependencyHealth),
      edge("checkout-orders", "checkout", "orders", values.traffic / 100, writeHealth),
    ],
    metrics: [
      metric("production-error-rate", "Production error rate", values.totalError, "%", 1, 3, "percent"),
      metric("checkout-error-rate", "Checkout error rate", values.pathError, "%", 0.5, 2, "percent"),
      metric("dependency-error-rate", "Dependency error rate", values.dependencyError, "%", 0.5, 2, "percent"),
      metric("write-failure-rate", "Write failure rate", values.writeError, "%", 0.5, 2, "percent"),
      metric("false-pass-rate", "Smoke false-pass rate", values.falsePassRate, "%", 33, 66, "percent"),
      metric("coverage-gap", "Smoke coverage gap", values.coverageGap, "%", 20, 40, "percent"),
      metric("escaped-defects", "Escaped defects", values.escaped, "", 1, 2, "count"),
      metric("traffic-on-new", "Traffic on new version", values.traffic, "%", undefined, undefined, "percent"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), detected: values.detected ? 1 : 0, traffic: values.traffic },
    summary: `${values.detected ? "Smoke suite blocked the release" : "Smoke suite passed"} · traffic ${percent(values.traffic)} · errors ${percent(values.totalError)} · escaped ${values.escaped}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.5);
  const series: [string, number][] = [
    ["production-error-rate", values.totalError],
    ["checkout-error-rate", values.pathError],
    ["dependency-error-rate", values.dependencyError],
    ["write-failure-rate", values.writeError],
    ["false-pass-rate", values.falsePassRate],
    ["coverage-gap", values.coverageGap],
    ["escaped-defects", values.escaped],
    ["traffic-on-new", values.traffic],
    ["checkout-p99", values.p99],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "production-error-rate",
    metricId: "production-error-rate",
    warn: 1,
    crit: 3,
    title: "The new version is failing in production",
    cause: "The smoke suite reported a pass without exercising the broken checkout path, so the release received traffic and users found the failure.",
    fix: "Stop the rollout or roll back. Add the missing smoke test, prove it fails on the bad build, and make a smoke failure block promotion.",
    checkFirst: [
      "Check whether the smoke suite called the checkout endpoint users call.",
      "Check whether it used the real payment dependency or a mock.",
      "Compare new-version and stable-version errors at the same timestamp.",
    ],
  },
  {
    id: "false-pass-rate",
    metricId: "false-pass-rate",
    warn: 33,
    crit: 66,
    title: "The smoke suite is green because it tests too little",
    cause: "The suite passes while one or more release defects remain unobserved. A green result from a shallow suite is not evidence of a working critical path.",
    fix: "Add the missing path, dependency, or write read-back. Make the suite fail closed when coverage is incomplete, and never treat the pass rate as a quality signal by itself.",
    checkFirst: [
      "Check which critical path, dependency, or write the suite does not exercise.",
      "Check whether a mock or fixture avoids the failing code.",
      "Check whether the suite was recently reduced for speed or flakiness.",
    ],
  },
  {
    id: "coverage-gap",
    metricId: "coverage-gap",
    warn: 20,
    crit: 40,
    title: "Smoke coverage is below the deployment bar",
    cause: "The suite does not cover enough of the critical path, real dependencies, or write read-back to justify a promotion decision.",
    fix: "Restore the missing coverage before the next deploy. Keep the suite small, but require every critical outcome to have at least one real-path check.",
    checkFirst: [
      "Check coverage by dimension, not only the total number of tests.",
      "Check whether tests were skipped or quarantined for flakiness.",
      "Check whether the deployment gate enforces the coverage bar.",
    ],
  },
  {
    id: "escaped-defects",
    metricId: "escaped-defects",
    warn: 1,
    crit: 2,
    title: "A defect escaped the smoke gate",
    cause: "A release defect was not observed by the smoke suite. The suite passed and promotion continued, so the failure moved to users.",
    fix: "Trace the production failure back to the missing smoke check, add it, and require the check to fail against the bad artifact before the next release.",
    checkFirst: [
      "Check which user path failed in production but not in smoke.",
      "Check whether the smoke test used data that avoided the defect.",
      "Check whether the result was advisory rather than blocking.",
    ],
  },
];

export const smokeTestsModel: SimModel = {
  id: "deployment-smoke-tests",
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
      `The smoke suite covers ${Math.round(values.pathCoverage)}% of critical paths, ${Math.round(values.dependencyCoverage)}% of real dependency calls, and ${Math.round(values.writeCoverage)}% of writes with read-back.`,
    );
    items.push(
      values.detected
        ? "All three checks are present, so the suite fails on the broken checkout path and blocks promotion."
        : `The suite passes with ${values.escaped} escaped defect${values.escaped === 1 ? "" : "s"}. A green smoke result is not proof that checkout works.`,
    );
    items.push(
      `Production errors are ${percent(values.totalError)}: checkout ${percent(values.pathError)}, dependency ${percent(values.dependencyError)}, writes ${percent(values.writeError)}.`,
    );
    items.push(
      `Traffic on the new version is ${percent(values.traffic)}. The health probe stays green in every case because it only checks the process.`,
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
    description: "Path, real dependency, and write read-back are covered; the suite catches the defect.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial suite",
    description: "The dependency is mocked and 10% of traffic moves before the gap is noticed.",
    tone: "warn",
    params: defaults({ realDependencyCoverage: 60, trafficExposedPercent: 10 }),
  },
  {
    id: "failure",
    label: "Health only",
    description: "The probe is green while path, dependency, and write checks are all missing.",
    tone: "crit",
    params: defaults({ criticalPathCoverage: 20, realDependencyCoverage: 10, writeReadbackCoverage: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The suite is restored above the coverage bar and blocks the same broken release.",
    tone: "ok",
    params: defaults({ criticalPathCoverage: 90, realDependencyCoverage: 90, writeReadbackCoverage: 90 }),
  },
];

const experiment: Experiment = {
  id: "predict-smoke-gap",
  title: "Predict why the health check passed",
  simId: "smoke-tests",
  question:
    "A new task serves 200 on /health but returns 500 on checkout. The smoke suite reports a pass and traffic moves. Which smoke test was missing?",
  prediction: {
    options: [
      { id: "liveness", label: "A liveness probe with a shorter interval" },
      { id: "checkout", label: "A checkout smoke test that uses the real payment dependency and reads the order back" },
      { id: "replicas", label: "A third replica of the new task" },
      { id: "logs", label: "A log alert for the word error" },
    ],
    correctOptionId: "checkout",
    explanation:
      "A liveness probe only proves the process answers. Checkout calls application code, a real dependency, and a write. The smoke test has to exercise that path and read the result back, or the suite can be green while the user outcome is broken.",
  },
  setup: defaults({ criticalPathCoverage: 20, realDependencyCoverage: 10, writeReadbackCoverage: 10 }),
  runFor: 20,
  observe: [
    "The task and health probe stay green; the smoke suite also passes.",
    "Checkout errors reach 9.6%, dependency errors reach 18%, and writes fail at 7.2%.",
    "False-pass rate is 100% and all three defects escape.",
    "Traffic moves to the new version because the shallow suite reports success.",
  ],
  explain:
    "A smoke test is a user-outcome check, not a process check. It should call the critical path, use the real dependency, and read back any write it makes. If the test mocks payment or skips the write, it cannot observe the failure. Coverage is part of the test design, not an afterthought.",
  fix: defaults({ criticalPathCoverage: 90, realDependencyCoverage: 90, writeReadbackCoverage: 90 }),
  debrief:
    "With the restored suite, the same build fails smoke and promotion stops. The cost is test data, credentials, and a slightly slower deploy. The benefit is that the obvious user-facing failure is caught before traffic. A smoke suite that cannot fail is worse than no suite because it creates false confidence.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A smoke test is a small, fast check that a critical user path works after a deployment. It is not a unit test and not a full regression suite. It answers one question: can a user complete the outcome we care about right now, against the dependencies and data the release will actually use?",
  },
  {
    type: "p",
    text: "A health check is weaker. It proves the process is running, and sometimes that a local port answers. It does not authenticate to payment, write an order, or read that order back. A task can return 200 on the health endpoint and 500 on checkout at the same time. A smoke test is designed to observe that difference before users do.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Smoke tests run after the artifact starts and before promotion or traffic shift. They usually run against a dedicated test account or a small synthetic slice of production. The results feed the deployment gate: pass, promote; fail, stop or roll back. If the suite is only advisory, the deployment can continue after a failure, which turns the test into documentation rather than a control.",
  },
  {
    type: "compare",
    leftTitle: "Health check",
    rightTitle: "Smoke test",
    rows: [
      { label: "Question", left: "Is the process alive?", right: "Can the user complete the path?" },
      { label: "Dependency", left: "Often local or mocked", right: "Real client, credentials, and network" },
      { label: "Data", left: "No write", right: "Write and read-back where the path changes state" },
      { label: "Result", left: "200 from the probe", right: "Expected user-visible result" },
      { label: "Gate", left: "Restart the task", right: "Block promotion or roll back" },
    ],
  },
  {
    type: "p",
    text: "This model uses an illustrative service rate, coverage percentages, and error rates. The defect is fixed: the release has a broken checkout path, a payment dependency failure, and a write that is accepted but not durable. A smoke suite only catches them if it covers the path, the real dependency, and the read-back.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Critical-path, real-dependency, and write read-back coverage, shown separately.",
      "Smoke false-pass rate and escaped defects, which explain a green suite over a broken release.",
      "Checkout, dependency, and write failures after traffic moves.",
      "Traffic on the new version: zero when smoke blocks, nonzero when it passes.",
      "Health probe and task nodes that stay green while the user path fails.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and note that the suite blocks the broken build. Apply Health only to let all three defects escape. Try Partial suite to see one mocked dependency weaken the gate. Use the experiment to choose the check that would have caught checkout.",
  },
  {
    type: "table",
    headers: ["Smoke check", "What it catches", "What it misses"],
    rows: [
      ["Liveness only", "Crashed or hung process", "Every user path and real dependency"],
      ["Checkout read", "Wrong status or payload on the main path", "Writes that are accepted but not durable"],
      ["Real dependency call", "Authentication, timeout, or contract failure", "Paths and dependencies not called"],
      ["Write and read-back", "Lost or unreadable writes", "Async consumers and downstream effects"],
    ],
  },
  { type: "sim", simId: "smoke-tests" },
  { type: "experiment", experimentId: "predict-smoke-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the health-only preset, the task and the probe stayed green. The smoke suite also passed because it never called checkout, never used the real payment client, and never read an order back. Traffic moved, and checkout errors reached 9.6%, dependency errors 18%, and write failures 7.2%. The false-pass rate was 100%.",
  },
  {
    type: "p",
    text: "With the suite restored above the coverage bar, the same build failed smoke and promotion stopped. This is the point of a smoke test: it converts an obvious user-facing failure into a deployment decision before users see it. The test does not need to be broad. It needs to touch the real path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Task start, health probe result, smoke result, promotion decision, and traffic shift as deployment events.",
      "Per-check status with the path, dependency, and write that was exercised.",
      "New-version error rate before and after promotion.",
      "Dependency authentication and timeout errors, including the client version used by the test.",
      "Synthetic write records, read-back results, and cleanup status.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the smoke test called the same checkout endpoint users call. Check whether it used the real dependency or a mock. Check whether it read the write back. Check whether a smoke failure actually blocks promotion or only sends a notification.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop promotion and roll back if the error budget is at risk.",
      "Trace the failed user outcome to the smoke check that should have observed it.",
      "Add the real path, dependency, and write read-back with production-like credentials.",
      "Prove the new check fails against the bad build and passes against the fixed build.",
      "Make smoke failure block promotion, not just alert.",
      "Keep the suite small and fast enough to run on every deployment.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Real dependencies catch more defects but make the suite depend on their availability.",
      "Test writes need unique data and cleanup so they do not pollute production records.",
      "A blocking gate reduces escaped defects but can stop deploys on test-environment problems.",
      "A small suite stays fast but may miss paths outside its scope.",
      "Running smoke after promotion catches more real traffic but exposes users to the defect.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "health-vs-smoke",
    question:
      "A new task serves 200 on /health but 500 on checkout. What smoke test would you add, and why did the health check miss it?",
    difficulty: 2,
    hints: [
      "Health proves the process, not the user path.",
      "Checkout uses a real dependency and writes an order.",
      "A write is not proven until it is read back.",
    ],
    answer:
      "I would add a smoke test that calls checkout through the real payment dependency and reads the order back through the user path. The health check missed it because it only proves the process answers and does not authenticate to payment or write data. The smoke test should run before promotion and block the release when it fails.",
    followUps: [
      "How would you avoid creating duplicate orders?",
      "What would you do if payment is unavailable during the deploy?",
      "Which part of the path would you check first if the suite must stay under a minute?",
    ],
    redFlags: [
      "Adds more liveness probes.",
      "Mocks payment in the only checkout test.",
      "Treats smoke failure as advisory.",
    ],
    rubric: [
      "Names the checkout path.",
      "Uses the real dependency.",
      "Reads the write back.",
      "Blocks promotion on failure.",
    ],
  },
  {
    id: "smoke-scope",
    question: "How small can a smoke suite be without becoming useless?",
    difficulty: 2,
    hints: [
      "Start from the outcomes that justify the deployment.",
      "One real check per critical path is often enough.",
      "A suite that cannot fail is not a gate.",
    ],
    answer:
      "I would keep one representative check per critical outcome, and make each check exercise the real dependency and any write that changes state. That can be a handful of tests. The suite is useful if it can fail on a realistic release defect and if its failure blocks promotion. It becomes useless when it only checks liveness, mocks the dependency that usually breaks, or runs after traffic has already moved.",
    followUps: [
      "How do you keep test data from accumulating?",
      "What do you do when a smoke test is flaky?",
      "How does the suite change for a database migration?",
    ],
    redFlags: [
      "Optimizes only for test count.",
      "Removes the real dependency to reduce flakiness.",
      "Has no promotion consequence.",
    ],
    rubric: [
      "Starts from critical outcomes.",
      "Uses real dependencies and writes.",
      "Keeps the gate blocking.",
      "Handles data cleanup.",
    ],
  },
  {
    id: "advisory-smoke",
    question:
      "A team runs smoke tests after promotion and only sends a Slack notification on failure. What is wrong with that design?",
    difficulty: 2,
    hints: [
      "A test after exposure is monitoring, not a gate.",
      "A notification without an owner or action is not a control.",
      "The cost of a missed checkout failure is usually much higher than a blocked deploy.",
    ],
    answer:
      "The smoke test is no longer protecting users; it is observing them fail. Promotion has already exposed the defect, and a notification may not be seen or acted on quickly. I would move the critical-path smoke test before promotion, make its failure block traffic, and keep a post-promotion synthetic check as a second layer. I would also define who responds and what rollback or pause action follows a failure.",
    followUps: [
      "When is a post-promotion smoke check still useful?",
      "How would you migrate from advisory to blocking without breaking delivery?",
      "What would you do about a flaky smoke test that blocks too often?",
    ],
    redFlags: [
      "Treats a notification as a gate.",
      "Runs the only smoke check after exposure.",
      "Has no owner or rollback action.",
    ],
    rubric: [
      "Moves the gate before promotion.",
      "Makes failure block traffic.",
      "Keeps a post-promotion check as a second layer.",
      "Defines ownership and action.",
    ],
  },
];

const checklist = [
  {
    title: "Design the suite",
    items: [
      "List the critical user outcomes that justify a deployment gate.",
      "Choose one representative path per outcome.",
      "Use the real dependency client, credentials, and network path.",
      "Add a write and read-back where the outcome changes state.",
      "Define unique test data and cleanup for every run.",
    ],
  },
  {
    title: "Run the gate",
    items: [
      "Run smoke after the artifact starts and before traffic moves.",
      "Fail the deployment on a smoke failure rather than only alerting.",
      "Record which path, dependency, and write each check exercised.",
      "Compare the new version with the stable version at the same timestamp.",
      "Keep the suite fast enough to run on every deploy.",
    ],
  },
  {
    title: "After a miss",
    items: [
      "Trace the escaped defect to the missing check.",
      "Add the check and prove it fails on the bad artifact.",
      "Review whether a mock or fixture avoided the failure.",
      "Confirm the gate still blocks promotion after the change.",
      "Recheck the suite after any dependency or credential change.",
    ],
  },
];

const references = [
  {
    title: "Configure Liveness, Readiness and Startup Probes",
    url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    publisher: "Kubernetes Documentation",
    kind: "docs" as const,
    note: "What liveness and readiness probes prove, and why they are not user-path tests.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release gates, canarying, and the role of verification before broad traffic.",
  },
  {
    title: "Implement automated testing for code and infrastructure",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/dl.cr.4-implement-automated-testing-for-code-and-infrastructure.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Automated testing across the delivery pipeline, including deployment checks.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "smoke-tests": {
      model: smokeTestsModel,
      presets,
      instructions:
        "Start with Healthy. The suite blocks the broken build and traffic stays at zero. Apply Health only to see the probe and the smoke suite both pass while checkout fails. Use Partial suite to see a mocked dependency weaken the gate.",
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
    "deployment-canary",
    "deployment-verification",
    "deployment-canary-metric-gate",
    "deployment-automated-rollback",
  ],
};
