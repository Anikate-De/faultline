import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 12_000;

const params: ParamSpec[] = [
  {
    id: "criticalPathCoverage",
    label: "Critical-path check coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Verification",
    help: "Share of critical user paths exercised after deployment, such as search, cart, checkout, and receipt.",
    format: "percent",
  },
  {
    id: "dependencyCoverage",
    label: "Dependency check coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Verification",
    help: "Share of external dependencies exercised through their real client, credentials, and network path rather than a mock.",
    format: "percent",
  },
  {
    id: "dataCoverage",
    label: "Data read-back coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Verification",
    help: "Share of verification writes that are read back through the same path a user or downstream service would use.",
    format: "percent",
  },
  {
    id: "trafficShiftPercent",
    label: "Traffic shifted after checks",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Release",
    help: "Share of production traffic moved to the new version if verification does not block the release.",
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
  dataCoverage: number;
  pathGap: number;
  dependencyGap: number;
  dataGap: number;
  coverageGap: number;
  detected: boolean;
  traffic: number;
  checkoutError: number;
  dependencyError: number;
  dataError: number;
  totalError: number;
  escaped: number;
  p99: number;
}

function compute(p: Params): Values {
  const pathCoverage = clamp(num(p, "criticalPathCoverage", 100), 0, 100);
  const dependencyCoverage = clamp(num(p, "dependencyCoverage", 100), 0, 100);
  const dataCoverage = clamp(num(p, "dataCoverage", 100), 0, 100);
  const shift = clamp(num(p, "trafficShiftPercent", 100), 0, 100);
  const pathGap = 100 - pathCoverage;
  const dependencyGap = 100 - dependencyCoverage;
  const dataGap = 100 - dataCoverage;
  const coverageGap = (pathGap + dependencyGap + dataGap) / 3;
  const detected = pathCoverage >= 70 && dependencyCoverage >= 70 && dataCoverage >= 70;
  const traffic = detected ? 0 : shift;
  const share = traffic / 100;
  const checkoutError = (pathGap / 100) * share * 8;
  const dependencyError = (dependencyGap / 100) * share * 6;
  const dataError = (dataGap / 100) * share * 5;
  const totalError = checkoutError + dependencyError + dataError;
  const escaped = detected ? 0 : [pathGap > 0, dependencyGap > 0, dataGap > 0].filter(Boolean).length;
  const p99 = 90 + totalError * 30 + coverageGap * 0.8;

  return {
    pathCoverage,
    dependencyCoverage,
    dataCoverage,
    pathGap,
    dependencyGap,
    dataGap,
    coverageGap,
    detected,
    traffic,
    checkoutError,
    dependencyError,
    dataError,
    totalError,
    escaped,
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
  const checkoutHealth = errorHealth(values.checkoutError, 0.5, 2);
  const dependencyHealth = errorHealth(values.dependencyError, 0.5, 2);
  const dataHealth = errorHealth(values.dataError, 0.5, 1.5);
  const trafficHealth = errorHealth(values.totalError, 1, 3);
  const verificationHealth: Health =
    values.detected ? "ok" : values.totalError >= 3 ? "crit" : values.escaped > 0 ? "warn" : "ok";
  const overall = worst(checkoutHealth, dependencyHealth, dataHealth, trafficHealth, verificationHealth);

  const stageNodes = [
    {
      id: "artifact",
      label: "New artifact",
      kind: "service" as const,
      health: "ok" as const,
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: "built and started",
      detail: "The artifact starts and the process stays up. This proves packaging and startup, not that a user path works.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "health-gate",
      label: "Health check",
      kind: "service" as const,
      health: "ok" as const,
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: "process returns 200",
      detail: "The liveness endpoint answers. It does not call checkout, the payment dependency, or the write path, so it can pass while those are broken.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "verification",
      label: values.detected ? "Verification blocks" : "Verification passes",
      kind: "service" as const,
      health: verificationHealth,
      utilization: clamp(values.coverageGap / 100),
      throughput: 0,
      capacity: TOTAL_RPS,
      sublabel: `path ${Math.round(values.pathCoverage)}% · dep ${Math.round(values.dependencyCoverage)}% · data ${Math.round(values.dataCoverage)}%`,
      detail: values.detected
        ? "The checks exercised the critical path, the real dependency, and the write read-back. The release is blocked before production traffic moves."
        : "At least one check is missing. The suite does not observe the broken checkout outcome, so it reports a pass and the release proceeds.",
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
      sublabel: `${percent(values.traffic)} shifted · errors ${percent(values.totalError)}`,
      detail:
        values.traffic > 0
          ? `The new version serves ${Math.round((values.traffic / 100) * TOTAL_RPS).toLocaleString()} rps. Its checkout error rate is ${percent(values.checkoutError)}.`
          : "No production traffic moved to the new version. The previous version continues to serve.",
      meta: { stage: "full", view: "deployment" },
    },
    {
      id: "dependency",
      label: "Payment dependency",
      kind: "external" as const,
      health: dependencyHealth,
      utilization: 0.6,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `errors ${percent(values.dependencyError)}`,
      detail: "A verifier that mocks this dependency cannot observe an authentication, timeout, or contract failure in the real client.",
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
      label: values.detected ? "Stable checkout" : "New checkout",
      kind: "service" as const,
      health: worst(checkoutHealth, trafficHealth),
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `errors ${percent(values.checkoutError)}`,
      meta: { view: "flow" },
    },
    {
      id: "payment",
      label: "Payment dependency",
      kind: "external" as const,
      health: dependencyHealth,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: "real credentials and network",
      meta: { view: "flow" },
    },
    {
      id: "orders",
      label: "Orders database",
      kind: "db" as const,
      health: dataHealth,
      utilization: 0.65,
      throughput: (values.traffic / 100) * TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `corruption ${percent(values.dataError)}`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-checkout", "clients", "checkout", 1, overall),
      edge("checkout-payment", "checkout", "payment", values.traffic / 100, dependencyHealth),
      edge("checkout-orders", "checkout", "orders", values.traffic / 100, dataHealth),
    ],
    metrics: [
      metric("checkout-error-rate", "Checkout error rate", values.checkoutError, "%", 0.5, 2, "percent"),
      metric("dependency-error-rate", "Dependency error rate", values.dependencyError, "%", 0.5, 2, "percent"),
      metric("data-corruption-rate", "Order write failures", values.dataError, "%", 0.5, 1.5, "percent"),
      metric("verification-gap", "Verification coverage gap", values.coverageGap, "%", 20, 40, "percent"),
      metric("escaped-defects", "Escaped defects", values.escaped, "", 1, 2, "count"),
      metric("service-error-rate", "Service error rate", values.totalError, "%", 1, 3, "percent"),
      metric("traffic-on-new", "Traffic on new version", values.traffic, "%", undefined, undefined, "percent"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), detected: values.detected ? 1 : 0, traffic: values.traffic },
    summary: `${values.detected ? "Verification blocked the release" : "Verification passed the release"} · traffic ${percent(values.traffic)} · checkout errors ${percent(values.checkoutError)} · escaped ${values.escaped}`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 9)) / 2.6);
  const series: [string, number][] = [
    ["checkout-error-rate", values.checkoutError],
    ["dependency-error-rate", values.dependencyError],
    ["data-corruption-rate", values.dataError],
    ["verification-gap", values.coverageGap],
    ["escaped-defects", values.escaped],
    ["service-error-rate", values.totalError],
    ["traffic-on-new", values.traffic],
    ["checkout-p99", values.p99],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "checkout-error-rate",
    metricId: "checkout-error-rate",
    warn: 0.5,
    crit: 2,
    title: "The checkout path is failing after deployment",
    cause: "The verification suite did not exercise the complete checkout path, so a broken dependency or write path was discovered by users instead of the gate.",
    fix: "Stop the traffic shift and roll back if the error budget is at risk. Add a checkout verification that uses the real payment client and reads the order back before promotion.",
    checkFirst: [
      "Check whether the verification calls the same checkout endpoint users call.",
      "Check whether the dependency was mocked or bypassed.",
      "Compare new-version and stable-version checkout errors, not the blended rate.",
    ],
  },
  {
    id: "dependency-error-rate",
    metricId: "dependency-error-rate",
    warn: 0.5,
    crit: 2,
    title: "A real dependency failed only after traffic moved",
    cause: "The verifier used a mock, a stubbed client, or a network path that did not match production. Authentication, timeout, or contract errors stayed hidden until real traffic arrived.",
    fix: "Verify through the production client, credentials, and network path. Add a dependency-specific check and treat its failure as a promotion blocker.",
    checkFirst: [
      "Check whether the verification used the real client and credentials.",
      "Check DNS, egress, and timeout settings for the verification environment.",
      "Check the dependency's own error and latency metrics at the deployment timestamp.",
    ],
  },
  {
    id: "data-corruption-rate",
    metricId: "data-corruption-rate",
    warn: 0.5,
    crit: 1.5,
    title: "Verification writes are failing or not durable",
    cause: "The check posted a write but never read it back through the user path. A serialization, constraint, or downstream consumer failure can return success to the caller and still lose the order.",
    fix: "Make verification write a uniquely identifiable record and read it back through the same query path. Clean up the record and alert on write success without read-back success.",
    checkFirst: [
      "Check whether the verification performed a write and a read-back.",
      "Check the order database constraints, triggers, and downstream consumers.",
      "Check whether the write returned success before the transaction committed.",
    ],
  },
  {
    id: "verification-gap",
    metricId: "verification-gap",
    warn: 20,
    crit: 40,
    title: "Verification coverage is too thin to trust a pass",
    cause: "At least one of the critical path, dependency, or data checks is missing. The suite can report green because it never observes the failure it is supposed to catch.",
    fix: "Add the missing check before the next release. Treat incomplete verification coverage as a failed gate, not as a reason to proceed with a smaller check set.",
    checkFirst: [
      "Check which of the three dimensions is below its coverage target.",
      "Check whether the missing check is mocked or simply absent.",
      "Check whether the last successful deploy also had a coverage gap.",
    ],
  },
  {
    id: "escaped-defects",
    metricId: "escaped-defects",
    warn: 1,
    crit: 2,
    title: "Defects escaped the deployment gate",
    cause: "The verification suite passed while one or more release defects were not exercised. A green deployment is not evidence of a working user path when the checks are incomplete.",
    fix: "Trace each escaped defect back to the missing check, add it, and keep the release blocked until the check fails against the bad build and passes against the fixed build.",
    checkFirst: [
      "Check which user path failed in production but not in verification.",
      "Check whether the check exists but used test data that avoided the defect.",
      "Check whether the gate can fail closed when coverage is incomplete.",
    ],
  },
];

export const deploymentVerificationModel: SimModel = {
  id: "deployment-verification",
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
      `The suite covers ${Math.round(values.pathCoverage)}% of critical paths, ${Math.round(values.dependencyCoverage)}% of dependencies, and ${Math.round(values.dataCoverage)}% of write read-backs.`,
    );
    items.push(
      values.detected
        ? "All three checks are present, so the broken checkout path is observed and the release is blocked before production traffic moves."
        : `The suite reports a pass with a ${percent(values.coverageGap)} coverage gap. That is why ${values.escaped} defect${values.escaped === 1 ? "" : "s"} reached production.`,
    );
    items.push(
      `Checkout errors are ${percent(values.checkoutError)}, dependency errors are ${percent(values.dependencyError)}, and write failures are ${percent(values.dataError)}.`,
    );
    items.push(
      `Production traffic on the new version is ${percent(values.traffic)}. A blocked release keeps that number at zero; a passing gate does not prove the user path works.`,
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
    description: "Path, dependency, and data checks all run; verification blocks the broken release.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial coverage",
    description: "The dependency check is thin and 25% of traffic moves before the gap is noticed.",
    tone: "warn",
    params: defaults({ dependencyCoverage: 60, trafficShiftPercent: 25 }),
  },
  {
    id: "failure",
    label: "Health only",
    description: "The process is healthy, but every user-path, dependency, and data check is missing.",
    tone: "crit",
    params: defaults({ criticalPathCoverage: 20, dependencyCoverage: 10, dataCoverage: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The missing checks are added; the same release is caught before traffic moves.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "data-gap",
    label: "Data gap",
    description: "Path and dependency checks pass, but writes are never read back.",
    tone: "crit",
    params: defaults({ dataCoverage: 40 }),
  },
];

const experiment: Experiment = {
  id: "predict-verification-gap",
  title: "Predict which verification would catch the broken checkout",
  simId: "deployment-verification",
  question:
    "The new task serves 200 on the health endpoint but 500 on checkout. The deployment gate is green. Which check was missing?",
  prediction: {
    options: [
      { id: "deeper-health", label: "A health check with a longer timeout" },
      { id: "path", label: "A critical-path check that runs checkout through the real payment dependency and reads the order back" },
      { id: "replicas", label: "More replicas of the new task" },
      { id: "logs", label: "A dashboard showing the process is still running" },
    ],
    correctOptionId: "path",
    explanation:
      "A health endpoint proves the process answers. The broken path includes application code, a real dependency, and a write. Only a check that exercises that whole path can observe the 500, and a read-back proves the write was durable rather than merely accepted.",
  },
  setup: defaults({ criticalPathCoverage: 20, dependencyCoverage: 10, dataCoverage: 10 }),
  runFor: 20,
  observe: [
    "Health and artifact nodes stay healthy while checkout errors reach 6.4%.",
    "Dependency errors and order write failures rise with traffic.",
    "Verification gap is 86.7%, and all three defects escape.",
    "Traffic is 100% on the new version because the incomplete gate passed.",
  ],
  explain:
    "Deployment verification is an outcome check, not a process check. It has to cover the path a user takes, the real dependency that path calls, and the data the path writes. If any of those is mocked or absent, the suite can be green while the user outcome is broken. Coverage is part of the gate, not a reporting detail.",
  fix: defaults(),
  debrief:
    "With all three checks present, the same broken build is blocked before production traffic moves. The cost is a slower deploy and test data that must be created and cleaned up. The benefit is that the deployment gate observes the user outcome instead of the process. The next step is to make the gate fail closed when coverage is incomplete.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Deployment verification is the evidence you collect after a build starts and before production traffic moves. It answers a narrow question: does this release perform the user outcome we depend on, against the dependencies and data it will use in production? A green process, a running container, or a 200 from a health endpoint does not answer that question.",
  },
  {
    type: "p",
    text: "Verification differs from a smoke test in scope, not in kind. A smoke test is a small set of checks that prove the critical path works. Verification is the gate that decides whether the release may receive traffic. It should cover critical user paths, real dependencies, and a write that is read back. Synthetic checks can supply the traffic and data when real users are not yet on the new version.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Verification sits between the deployment controller and the traffic switch. The artifact is running, but the load balancer still sends production traffic to the stable version. The verifier calls the new version through a route that exercises the same code, dependency clients, credentials, and data stores as production. If the checks pass, the controller shifts traffic. If they fail, promotion stops.",
  },
  {
    type: "compare",
    leftTitle: "Process health",
    rightTitle: "Deployment verification",
    rows: [
      { label: "Question", left: "Is the process alive?", right: "Does the critical user outcome work?" },
      { label: "Path", left: "Health endpoint only", right: "Checkout, payment, order write, read-back" },
      { label: "Dependencies", left: "Usually bypassed", right: "Real client, credentials, and network" },
      { label: "Failure signal", left: "Restart or 503", right: "Wrong result, 500, or missing data" },
      { label: "Decision", left: "Keep the task running", right: "Promote or block the release" },
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative coverage percentages and error rates. It assumes the release contains a real checkout defect, so a complete verification suite should catch it. The lesson is the shape of the gate: coverage of the path, the dependency, and the data determines whether the defect is observable at all.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Critical-path, dependency, and data read-back coverage, shown separately.",
      "Verification gap and escaped defects, which explain why a green gate can still be unsafe.",
      "Checkout, dependency, and order-write errors after traffic moves.",
      "Traffic on the new version: zero when verification blocks, higher when it passes.",
      "A deployment view from artifact to health check to verification to production traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. The release is broken, but full verification blocks it and traffic stays at zero. Apply Health only to see all three defects escape. Switch to Data gap to isolate a single missing read-back. Use the experiment to choose the check that would have caught checkout.",
  },
  {
    type: "table",
    headers: ["Check", "What it proves", "What it misses"],
    rows: [
      ["Liveness", "The process is running", "Every user path and dependency"],
      ["Critical path", "The main user journey returns the right result", "Paths and edge cases outside the script"],
      ["Dependency", "The real client, credentials, and network work", "Dependencies not called by the script"],
      ["Data read-back", "The write is durable and readable", "Data consumed asynchronously downstream"],
      ["Synthetic traffic", "The path works at a small scale before promotion", "Load and capacity at full traffic"],
    ],
  },
  { type: "sim", simId: "deployment-verification" },
  { type: "experiment", experimentId: "predict-verification-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The health-only preset kept the artifact and health nodes green while checkout errors reached 6.4%, dependency errors reached 5.4%, and order write failures reached 4.5%. The verification gap was 86.7% and all three defects escaped. Traffic moved to the new version because the gate never exercised the broken outcome.",
  },
  {
    type: "p",
    text: "With all three coverage dimensions at their target, the same release was blocked before traffic moved. The deployment looked slower, but the user-facing error rate stayed at zero. Verification did not fix the build. It prevented the build from reaching users.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment events: artifact started, verification started, checks passed or failed, traffic shifted.",
      "Per-check results with the exact path, dependency, and data query exercised.",
      "New-version error rate and latency before and after the traffic shift.",
      "Dependency authentication, timeout, and error metrics during verification.",
      "Synthetic write records and read-back confirmation, including cleanup status.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check which verification dimension is missing before reading the error rate. Check whether the failing path was mocked, skipped, or never called. Check whether the gate can block promotion when coverage is incomplete, and whether the traffic switch waits for the verification result.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the traffic shift and roll back if the error budget is at risk.",
      "Identify the user outcome that failed and the check that should have observed it.",
      "Add the missing path, dependency, or read-back check using production-like credentials and data.",
      "Prove the check fails against the bad build and passes against the fixed build.",
      "Make the promotion gate fail closed when coverage is below target.",
      "Keep a small synthetic canary running after promotion to catch slow failures.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Broader verification slows delivery and needs test data, credentials, and cleanup.",
      "Real dependencies catch more defects but make the gate depend on their availability.",
      "Synthetic data is controllable but can miss production-only shapes and volumes.",
      "A strict gate reduces escaped defects but increases blocked deploys and false positives.",
      "A post-promotion synthetic canary catches slow failures but exposes a small amount of traffic.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "green-deploy",
    question:
      "The deployment is green and the health endpoint returns 200, but checkout is returning 500. What verification was missing?",
    difficulty: 2,
    hints: [
      "A health endpoint proves process liveness, not a user outcome.",
      "Checkout calls a dependency and writes an order.",
      "A write is not proven until it is read back.",
    ],
    answer:
      "The gate was checking process health, not the checkout outcome. I would add a verification that calls checkout through the real payment dependency and reads the order back through the user path. That check should run against the new version before traffic moves, and a failure should block promotion. I would also make coverage part of the gate so a suite cannot pass while the checkout path is absent.",
    followUps: [
      "How would you keep the verification from creating duplicate orders?",
      "What would you do if the payment dependency is unavailable during the deploy?",
      "Which check would you add first if you could add only one?",
    ],
    redFlags: [
      "Trusts the health endpoint as proof of function.",
      "Mocks the dependency that is failing.",
      "Has no blocking condition on verification failure.",
    ],
    rubric: [
      "Names the user outcome.",
      "Uses a real dependency.",
      "Reads the write back.",
      "Blocks promotion on failure.",
    ],
  },
  {
    id: "verification-scope",
    question:
      "How do you decide what a deployment verification suite should cover without turning it into a full regression suite?",
    difficulty: 2,
    hints: [
      "Start from the user outcomes that create revenue or safety risk.",
      "Cover the dependencies and data those outcomes touch.",
      "A small suite that fails closed beats a broad suite that is ignored.",
    ],
    answer:
      "I would start from a short list of critical user outcomes, then add the dependencies and data each outcome touches. I would include one representative path per outcome, a real dependency call, and a write/read-back where the outcome changes state. I would keep the suite small enough to run on every deploy, set a coverage target for those dimensions, and fail closed when a check is missing. Broader regression coverage belongs in pre-merge tests, not in the deployment gate.",
    followUps: [
      "How would you choose between two critical paths with limited test capacity?",
      "What do you do when the verification itself is flaky?",
      "How does the suite change for a database migration release?",
    ],
    redFlags: [
      "Tries to run the entire regression suite in the gate.",
      "Covers only HTTP 200s.",
      "Lets a missing check pass silently.",
    ],
    rubric: [
      "Starts from user outcomes.",
      "Covers dependencies and data.",
      "Keeps the suite fast and focused.",
      "Fails closed on coverage gaps.",
    ],
  },
  {
    id: "gate-placement",
    question:
      "When should a check live in deployment verification instead of the pre-merge test suite?",
    difficulty: 2,
    hints: [
      "Pre-merge tests run against a build, not a deployed environment.",
      "Verification exists to decide whether traffic may move.",
      "Slow or environment-dependent checks belong closer to deployment.",
    ],
    answer:
      "Pre-merge tests should cover logic, contracts, and regressions against a deterministic build. Deployment verification should cover the things that only exist after deployment: real credentials, network paths, service discovery, configuration, and the deployed artifact's behavior against real dependencies. I would put a check in verification if its result depends on the environment and it must gate promotion. I would keep it small and fast enough to run before every traffic shift.",
    followUps: [
      "Which checks would you run in both places?",
      "How do you keep environment-specific checks from becoming flaky?",
      "What belongs in a post-promotion synthetic check instead?",
    ],
    redFlags: [
      "Moves the entire regression suite into the deployment gate.",
      "Duplicates every unit test against production.",
      "Has no distinction between build correctness and deployed behavior.",
    ],
    rubric: [
      "Separates build logic from environment behavior.",
      "Names deployed-only dependencies.",
      "Keeps the gate small and blocking.",
      "Places post-promotion checks correctly.",
    ],
  },
];

const checklist = [
  {
    title: "Design the gate",
    items: [
      "List the critical user outcomes and the path each one takes.",
      "Name the real dependencies and credentials each path uses.",
      "Decide which writes need a read-back to prove durability.",
      "Set a coverage target for path, dependency, and data checks.",
      "Define the promotion rule when verification fails or cannot run.",
    ],
  },
  {
    title: "Before promotion",
    items: [
      "Run the checks against the new version before production traffic moves.",
      "Use production-like data and clean up synthetic records.",
      "Compare new-version results with the stable version, not only with a fixed expectation.",
      "Confirm the gate blocks traffic on failure rather than only alerting.",
      "Record which checks ran, which were skipped, and why.",
    ],
  },
  {
    title: "After promotion",
    items: [
      "Keep a small synthetic canary on the critical path.",
      "Watch error rate, latency, and dependency health for a full traffic cycle.",
      "Trace any escaped defect back to the missing check.",
      "Add the check before the next release and verify it fails on a known bad build.",
      "Review whether the verification data and dependencies still match production.",
    ],
  },
];

const references = [
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release process, verification, and the difference between a build and a working service.",
  },
  {
    title: "Implement automated testing for code and infrastructure",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/devops-guidance/dl.cr.4-implement-automated-testing-for-code-and-infrastructure.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Automated testing across the delivery pipeline, including deployment verification.",
  },
  {
    title: "Configure Liveness, Readiness and Startup Probes",
    url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/",
    publisher: "Kubernetes Documentation",
    kind: "docs" as const,
    note: "What liveness and readiness probes prove, and what they do not.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "deployment-verification": {
      model: deploymentVerificationModel,
      presets,
      instructions:
        "Start with Healthy and note that traffic stays at zero because verification blocks the broken build. Apply Health only to let all defects escape, then Data gap to isolate the missing read-back. Run the experiment.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Coverage percentages, error rates, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-smoke-tests",
    "deployment-canary",
    "deployment-canary-metric-gate",
    "deployment-automated-rollback",
  ],
};
