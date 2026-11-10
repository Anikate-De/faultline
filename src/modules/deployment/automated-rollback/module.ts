import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ERROR_GATE = 1;
const MANUAL_MULTIPLIER = 20;
const RECOVERY_TARGET_SECONDS = 300;

const params: ParamSpec[] = [
  {
    id: "releaseErrorRate",
    label: "New release error rate",
    min: 0,
    max: 20,
    step: 0.1,
    value: 0.2,
    unit: "%",
    group: "Release",
    help: "Requests handled by the new release that return an error. The automated gate compares this with its 1 percent trigger.",
    format: "percent",
  },
  {
    id: "detectionWindowSeconds",
    label: "Detection window",
    min: 10,
    max: 300,
    step: 10,
    value: 30,
    unit: "s",
    group: "Gate",
    help: "How long the error signal must stay above the gate before the controller starts rollback. A longer window reduces false triggers and increases exposure.",
    format: "number",
  },
  {
    id: "previousArtifactRetained",
    label: "Previous artifact retained (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Rollback path",
    help: "One means the previous immutable artifact is still available to deploy. Zero models a rebuild and manual path, which is much slower.",
    format: "count",
  },
  {
    id: "rollbackDurationSeconds",
    label: "Prepared rollback duration",
    min: 10,
    max: 300,
    step: 10,
    value: 45,
    unit: "s",
    group: "Rollback path",
    help: "Time to restore the previous artifact when it is available, including scheduling and health checks in this model.",
    format: "number",
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
  errorRate: number;
  detectionWindow: number;
  artifactRetained: boolean;
  rollbackDuration: number;
  triggered: boolean;
  pathSeconds: number;
  recoverySeconds: number;
  exposure: number;
}

function compute(p: Params): Values {
  const errorRate = clamp(num(p, "releaseErrorRate", 0.2), 0, 100);
  const detectionWindow = Math.max(0, num(p, "detectionWindowSeconds", 30));
  const artifactRetained = num(p, "previousArtifactRetained", 1) >= 0.5;
  const rollbackDuration = Math.max(1, num(p, "rollbackDurationSeconds", 45));
  const triggered = errorRate >= ERROR_GATE;
  const pathSeconds = artifactRetained ? rollbackDuration : rollbackDuration * MANUAL_MULTIPLIER;
  const recoverySeconds = triggered ? detectionWindow + pathSeconds : 0;
  const exposure = triggered ? (errorRate * recoverySeconds) / 60 : 0;

  return {
    errorRate,
    detectionWindow,
    artifactRetained,
    rollbackDuration,
    triggered,
    pathSeconds,
    recoverySeconds,
    exposure,
  };
}

function releaseHealth(value: number): Health {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function recoveryHealth(seconds: number, triggered: boolean): Health {
  if (!triggered) return "ok";
  if (seconds >= 300) return "crit";
  if (seconds >= 120) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)}%`;
}

function minutes(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`;
}

function buildFrame(values: Values, seed: number): SimFrame {
  const release = releaseHealth(values.errorRate);
  const rollback = recoveryHealth(values.recoverySeconds, values.triggered);
  const artifact: Health = values.artifactRetained ? "ok" : "warn";

  const stageNodes = [
    {
      id: "previous",
      label: "Previous release",
      kind: "service" as const,
      health: artifact,
      utilization: values.artifactRetained ? 0.2 : 1,
      sublabel: values.artifactRetained ? "immutable artifact available" : "artifact missing · manual path",
      detail: values.artifactRetained
        ? "The previous artifact is retained and can be restored without rebuilding. This is what makes the rollback path fast."
        : "The previous artifact is not available. Restoring it requires a rebuild or manual reconstruction, so the modeled rollback path is much longer.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "release",
      label: "New release",
      kind: "service" as const,
      health: release,
      utilization: clamp(values.errorRate / 20),
      sublabel: `${percent(values.errorRate)} errors · gate ${ERROR_GATE}%`,
      detail: `The new release returns ${percent(values.errorRate)} errors. The automated gate triggers when the rate stays at or above ${ERROR_GATE}% for the detection window.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "controller",
      label: "Rollback controller",
      kind: "service" as const,
      health: rollback,
      utilization: clamp(values.recoverySeconds / RECOVERY_TARGET_SECONDS),
      sublabel: values.triggered
        ? `Triggered · recovery ${minutes(values.recoverySeconds)}`
        : "Standby · no trigger",
      detail: values.triggered
        ? `Detection is ${Math.round(values.detectionWindow)}s and the rollback path is ${Math.round(values.pathSeconds)}s, so users see errors for about ${minutes(values.recoverySeconds)}.`
        : "The error rate is below the gate, so automated rollback stays idle. That does not prove the release is healthy; it only proves the trigger did not fire.",
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    {
      id: "clients",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "Service",
      kind: "service" as const,
      health: release,
      sublabel: `${percent(values.errorRate)} errors`,
      meta: { view: "flow" },
    },
    {
      id: "artifact",
      label: "Artifact registry",
      kind: "storage" as const,
      health: artifact,
      sublabel: values.artifactRetained ? "previous digest retained" : "previous digest missing",
      detail: "An immutable artifact identified by digest is the rollback unit. If it was deleted or never retained, the previous version cannot be restored quickly.",
      meta: { view: "flow" },
    },
    {
      id: "rollback",
      label: "Rollback controller",
      kind: "service" as const,
      health: rollback,
      sublabel: values.triggered ? `${minutes(values.recoverySeconds)} recovery` : "idle",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service", 1, release),
      edge("service-artifact", "service", "artifact", values.artifactRetained ? 0.2 : 1, artifact),
      edge("artifact-rollback", "artifact", "rollback", values.triggered ? 1 : 0.1, rollback),
    ],
    metrics: [
      metric("release-error-rate", "Release error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("recovery-seconds", "Recovery time", values.recoverySeconds, "s", 120, 300, "number"),
      metric("error-exposure", "Error exposure", values.exposure, " %-min", 60, 300, "number"),
      metric("artifact-ready", "Artifact ready", values.artifactRetained ? 100 : 0, "%", undefined, undefined, "percent"),
      metric("rollback-path", "Rollback path", values.pathSeconds, "s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, artifactRetained: values.artifactRetained ? 1 : 0 },
    summary: values.triggered
      ? `${percent(values.errorRate)} errors · rollback ${minutes(values.recoverySeconds)} · ${values.artifactRetained ? "artifact ready" : "artifact missing"}`
      : `${percent(values.errorRate)} errors · gate not triggered · ${values.artifactRetained ? "artifact ready" : "artifact missing"}`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const ids = ["release-error-rate", "recovery-seconds", "error-exposure", "artifact-ready", "rollback-path"];
  for (const id of ids) {
    const item = frame.metrics.find((entry) => entry.id === id);
    if (!item) continue;
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      if (item.value === 0) return 0;
      return Math.max(0, item.value * (0.98 + 0.02 * Math.sin((index + (seed % 8)) / 3.7)));
    });
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "release-error-rate",
    metricId: "release-error-rate",
    warn: 1,
    crit: 5,
    title: "The new release is above the automated error gate",
    cause:
      "The release is returning errors at or above the trigger. The controller will start rollback after the detection window, but users see errors for the whole recovery time.",
    fix:
      "Let the automated rollback run if the artifact and schema are compatible. If rollback is not possible, stop the rollout manually and roll forward with a tested fix.",
    checkFirst: [
      "Compare the new release error rate with the previous release.",
      "Check whether the gate is measuring per-release data or a blended rate.",
      "Check whether errors are new status codes, timeouts, or dependency failures.",
    ],
  },
  {
    id: "recovery-seconds",
    metricId: "recovery-seconds",
    warn: 120,
    crit: 300,
    title: "Recovery is slower than the target",
    cause:
      "Detection plus rollback execution exceeds the target. The usual causes are a long detection window, a missing previous artifact, slow scheduling, or a manual approval in the path.",
    fix:
      "Shorten detection within the false-positive budget, retain the previous immutable artifact, pre-warm capacity, and test the rollback path end to end.",
    checkFirst: [
      "Check the detection window and the number of consecutive bad datapoints.",
      "Check that the previous artifact and configuration are available.",
      "Check scheduling, image pull, and readiness time during rollback.",
    ],
  },
  {
    id: "error-exposure",
    metricId: "error-exposure",
    warn: 60,
    crit: 300,
    title: "Users are exposed to errors for too long",
    cause:
      "Error rate multiplied by recovery time is the exposure. A moderate error rate with a slow rollback can hurt more users than a severe error rate with a fast one.",
    fix:
      "Reduce either term. Stop the rollout faster with a tighter gate, or restore the previous artifact faster with a retained artifact and a practiced rollback.",
    checkFirst: [
      "Check absolute error count, not only the error percentage.",
      "Check the time from first bad datapoint to rollback start.",
      "Check the time from rollback start to the first healthy instance.",
    ],
  },
];

export const automatedRollbackModel: SimModel = {
  id: "deployment-automated-rollback",
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
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10) * 0.01;
    next.metrics = next.metrics.map((item) =>
      item.id === "release-error-rate" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines: string[] = [];
    if (!values.triggered) {
      lines.push(
        `The release is at ${percent(values.errorRate)}, below the ${ERROR_GATE}% gate. The controller is idle; this does not prove the release is healthy, only that the trigger did not fire.`,
      );
    } else {
      lines.push(
        `The release is at ${percent(values.errorRate)}, above the ${ERROR_GATE}% gate. Detection takes ${Math.round(values.detectionWindow)}s and the rollback path takes ${Math.round(values.pathSeconds)}s.`,
      );
      lines.push(
        values.artifactRetained
          ? "The previous artifact is available, so the rollback path is the prepared restore path."
          : "The previous artifact is missing, so the model lengthens the rollback path to a rebuild and manual restore. That is the difference between a control loop and an incident.",
      );
      lines.push(
        `Users are exposed for about ${minutes(values.recoverySeconds)}. Error exposure is ${values.exposure.toFixed(1)} percent-minutes. Both detection and artifact availability are part of the recovery time.`,
      );
    }
    lines.push("Automated rollback is a recovery mechanism, not a deployment strategy. It still needs a compatible schema and a tested artifact.");
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
    label: "Healthy",
    description: "A 0.2 percent error release below the gate, with the previous artifact retained.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow detection",
    description: "A 1.5 percent error release, a 90-second detection window, and a 60-second rollback.",
    tone: "warn",
    params: defaults({ releaseErrorRate: 1.5, detectionWindowSeconds: 90, rollbackDurationSeconds: 60 }),
  },
  {
    id: "failure",
    label: "Missing artifact",
    description: "An 8 percent error release at 3 a.m. The previous artifact was deleted, so recovery takes about 21 minutes.",
    tone: "crit",
    params: defaults({ releaseErrorRate: 8, detectionWindowSeconds: 60, previousArtifactRetained: 0, rollbackDurationSeconds: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The release is healthy and the artifact is retained. No rollback is needed.",
    tone: "ok",
    params: defaults({ releaseErrorRate: 0.2, detectionWindowSeconds: 30, previousArtifactRetained: 1, rollbackDurationSeconds: 45 }),
  },
  {
    id: "late-gate",
    label: "Late gate",
    description: "The error gate waits 240 seconds before acting. Recovery reaches the critical target.",
    tone: "crit",
    params: defaults({ releaseErrorRate: 8, detectionWindowSeconds: 240, previousArtifactRetained: 1, rollbackDurationSeconds: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-recovery-time",
  title: "Predict how long users see errors",
  simId: "rollback-release",
  question:
    "The new release returns 8 percent errors. The gate detects after 60 seconds. The previous artifact was deleted, so restoration requires a rebuild modeled at 20 times the prepared 60-second path. When does user impact stop?",
  prediction: {
    options: [
      { id: "sixty", label: "After about 60 seconds, when the gate fires" },
      { id: "two", label: "After about 2 minutes, detection plus a normal rollback" },
      { id: "twentyone", label: "After about 21 minutes, detection plus the missing-artifact path" },
      { id: "never", label: "Never, because the automated controller cannot run without the artifact" },
    ],
    correctOptionId: "twentyone",
    explanation:
      "Detection is 60 seconds and the missing-artifact path is 60 seconds multiplied by 20, or 1,200 seconds. Total recovery is 1,260 seconds, about 21 minutes. The controller can still act, but it cannot restore an artifact it does not have quickly.",
  },
  setup: defaults({ releaseErrorRate: 8, detectionWindowSeconds: 60, previousArtifactRetained: 0, rollbackDurationSeconds: 60 }),
  runFor: 20,
  observe: [
    "Recovery time is 1,260 seconds, above the 300-second critical threshold.",
    "The rollback path is 1,200 seconds because the artifact is missing.",
    "Error exposure is about 168 percent-minutes at an 8 percent error rate.",
    "The release error rate stays critical; recovery time is a separate gate.",
  ],
  explain:
    "Automated rollback does not create a recovery path; it executes one. Detection is only the first term. The controller also needs the previous artifact, a compatible configuration and schema, schedulable capacity, and a readiness check that passes. If any of those are missing, the control loop either fails or falls back to a manual path, and user exposure grows with the delay.",
  fix: defaults({ releaseErrorRate: 0.2, detectionWindowSeconds: 30, previousArtifactRetained: 1, rollbackDurationSeconds: 45 }),
  debrief:
    "With the artifact retained and the release healthy, no rollback is needed. The important comparison is the failure case: 8 percent errors for 21 minutes versus a prepared path that would restore service in about 75 seconds. The cost of retaining artifacts and testing the rollback path is small compared with the exposure it removes. The tradeoff is storage and retention policy, plus the discipline to test rollback before the incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Automated rollback is a control loop around a deployment. It watches health checks or service metrics, decides that the new release is unhealthy, and restores the previous version without waiting for a human. The loop is only as good as its inputs and its recovery path. A fast detector with no artifact to restore is still a slow incident.",
  },
  {
    type: "p",
    text: "Recovery time has three parts. Detection is how long the bad signal must persist before the controller acts. Decision is the controller's evaluation and any approval or cooldown. Execution is restoring the previous artifact, scheduling it, passing readiness, and draining the bad version. A gate can shorten detection, but it cannot shorten artifact restoration if the artifact was deleted.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The controller sits in the deployment system: AWS CodeDeploy rollback, the Amazon Elastic Container Service (ECS) deployment circuit breaker, Argo Rollouts, or a custom pipeline. It reads health checks and metric alarms, then calls the same deployment API a human would use. The previous artifact lives in an image registry or artifact store. The schema and configuration live outside the artifact, so they are part of the rollback path too.",
  },
  {
    type: "p",
    text: "This model uses an illustrative 1 percent error gate, a 20-times multiplier for a missing-artifact rebuild, and a 300-second recovery target. The multiplier and thresholds are teaching values, not provider guarantees. The shape is the lesson: recovery time is detection plus the path you actually have, not the path you planned.",
  },
  {
    type: "table",
    headers: ["Recovery term", "What it includes", "How to shorten it"],
    rows: [
      ["Detection", "Bad datapoints, window, evaluation interval", "Tighter gate, fewer consecutive points, faster metrics"],
      ["Decision", "Policy, approvals, cooldown", "Pre-approved rollback, remove manual gates"],
      ["Execution", "Artifact restore, scheduling, readiness, drain", "Retain the artifact, pre-warm capacity, test the path"],
      ["Data compatibility", "Schema, migrations, side effects", "Expand/contract, compensating actions, tested rollback"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Release error rate compared with the automated gate.",
      "Detection window, rollback path duration, and total recovery time.",
      "Error exposure: error rate multiplied by recovery time.",
      "Artifact readiness and the rollback controller state.",
      "Previous release, new release, and controller stages.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Missing artifact. Compare recovery time with release error rate: the release is bad, but the artifact is what makes the incident long. Apply Late gate to see detection alone push recovery past the target. Use the experiment to predict exposure, then apply Recovery.",
  },
  {
    type: "compare",
    leftTitle: "Automated rollback",
    rightTitle: "Automated roll-forward",
    rows: [
      { label: "Action", left: "Restore the previous known artifact", right: "Deploy a new fix forward" },
      { label: "Strength", left: "Known code, tested path", right: "Avoids incompatible rollback" },
      { label: "Weakness", left: "Fails if the artifact or schema is incompatible", right: "Requires a correct fix under pressure" },
      { label: "Best when", left: "The release is the problem and state is compatible", right: "Rollback would corrupt data or lose side effects" },
    ],
  },
  {
    type: "p",
    text: "The break condition is a slow rollback because the previous artifact is unavailable. The controller may detect the failure correctly and still take far longer than the target, because it must rebuild or reconstruct the previous version. Automated rollback is not a substitute for artifact retention and a tested recovery path.",
  },
  { type: "sim", simId: "rollback-release" },
  { type: "experiment", experimentId: "predict-recovery-time" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the missing-artifact preset, the release returned 8 percent errors and the gate detected it after 60 seconds. The previous artifact was gone, so the rollback path became a rebuild and manual restore modeled at 20 times the prepared 60-second path. Total recovery was about 21 minutes. Detection worked; the recovery path did not.",
  },
  {
    type: "p",
    text: "The late-gate preset isolated the other term. The artifact was available, but a 240-second detection window plus a 60-second rollback reached the 300-second critical target. A fast artifact does not compensate for a slow decision, and a fast decision does not compensate for a missing artifact.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment events with rollback start, rollback completion, and the artifact digest.",
      "Alarm history showing when the error gate first fired and how many datapoints were bad.",
      "Per-release error rate, latency, and request count before and after rollback.",
      "Artifact registry retention status and image pull or scheduling failures.",
      "Schema migration events and any side effects that rollback cannot undo.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the previous artifact still exists and whether the schema is compatible. Then check the detection window and the rollback execution path. A green controller with a missing artifact is not a recovery plan.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Retain the previous immutable artifact for at least the rollback window.",
      "Test the rollback path end to end, including scheduling and readiness.",
      "Set the detection window from the error budget and the false-positive cost.",
      "Keep the schema backward compatible so rollback is possible.",
      "Pre-warm capacity or keep a standby environment for fast restoration.",
      "Record and review the actual recovery time after every rollback.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shorter detection window reduces exposure but increases false positives and rollback churn.",
      "A longer detection window avoids noise but lets a bad release run.",
      "Retaining artifacts costs storage and requires a retention policy that matches the rollback window.",
      "Keeping a warm standby speeds recovery but costs capacity every day.",
      "Rollback restores code, not data; migrations and external side effects may need a roll-forward or compensation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rollback-time",
    question:
      "A release is raising 5xx at 3 a.m. How fast can automated rollback happen without a human?",
    difficulty: 3,
    hints: [
      "Break the time into detection and execution.",
      "The previous artifact must exist.",
      "The schema must support the old version.",
    ],
    answer:
      "It depends on three terms: detection, decision, and execution. Detection is the gate window and the number of bad datapoints. Decision is the controller policy and any approval. Execution is restoring the previous artifact, scheduling it, and passing readiness. If the artifact is retained and the schema is compatible, recovery can be minutes. If the artifact is missing or the migration is destructive, the controller may detect quickly and still take a long time to recover.",
    followUps: [
      "How would you measure the actual recovery time?",
      "What would make rollback unsafe even with the artifact?",
      "When would you roll forward instead?",
    ],
    redFlags: [
      "Quotes a detection time without the execution path.",
      "Assumes the previous artifact is always available.",
      "Ignores schema compatibility.",
    ],
    rubric: [
      "Separates detection and execution.",
      "Checks artifact availability.",
      "Checks schema compatibility.",
      "Mentions measurement.",
    ],
  },
  {
    id: "gate-design",
    question:
      "How do you choose the error threshold and detection window for an automated rollback?",
    difficulty: 3,
    hints: [
      "Start from the error budget and the cost of a false rollback.",
      "A single bad datapoint is noisy.",
      "A slow gate extends user exposure.",
    ],
    answer:
      "I would choose a threshold that represents material user impact, then require enough consecutive bad datapoints to avoid reacting to one noisy sample. The window should be short enough that exposure stays inside the error budget and long enough that normal variance does not trigger rollback loops. I would test the gate against historical incidents and known false positives, and I would make the rollback path fast enough that detection is the dominant term only when it should be.",
    followUps: [
      "How does a low-traffic service change the window?",
      "What is the risk of a very aggressive gate?",
      "How would you test the gate before production?",
    ],
    redFlags: [
      "Picks a threshold without the error budget.",
      "Uses one datapoint.",
      "Ignores false positives and rollback loops.",
    ],
    rubric: [
      "Ties the gate to impact.",
      "Requires consecutive datapoints.",
      "Balances exposure and false positives.",
      "Tests against history.",
    ],
  },
  {
    id: "artifact-policy",
    question:
      "Your registry keeps only the last artifact because of storage limits. What breaks, and how do you fix it?",
    difficulty: 3,
    hints: [
      "The rollback target may be older than the last artifact.",
      "Retention is a recovery decision.",
      "Test the restore path, not just the registry policy.",
    ],
    answer:
      "It breaks rollback for any release that is not the immediately previous artifact, and it may break rollback entirely if the last artifact is the bad one. I would set retention from the rollback window and the deployment frequency, keep the last known good digest, and verify that the artifact can still be pulled by the deploy system. I would also test a restore from the registry, because a retention policy that looks correct can still fail on permissions or replication.",
    followUps: [
      "How long should the rollback window be?",
      "What about configuration and schema artifacts?",
      "How would you verify the artifact before an incident?",
    ],
    redFlags: [
      "Keeps only the latest because storage is cheap elsewhere.",
      "Assumes the latest artifact is always good.",
      "Never tests a pull or restore.",
    ],
    rubric: [
      "Ties retention to rollback.",
      "Keeps a known good digest.",
      "Checks permissions and replication.",
      "Tests the restore path.",
    ],
  },
  {
    id: "rollback-vs-forward",
    question:
      "The automated rollback is ready, but the release has already written new rows in a format the old version cannot read. What do you do?",
    difficulty: 4,
    hints: [
      "Rollback restores code, not data.",
      "A destructive migration can block the old version.",
      "Roll-forward needs a tested fix, not hope.",
    ],
    answer:
      "I would not run the rollback blindly. I would check whether the old version can read the new rows and whether the migration is reversible. If it cannot, the safe path may be roll-forward with a compatible fix or a data repair, not a code rollback. I would stop the rollout, preserve the new-format data, and involve the owners of the schema and the service. The recovery plan must cover data, not only the artifact.",
    followUps: [
      "What would you do if the fix is not ready?",
      "How do you prevent this in the next release?",
      "What does expand/contract change here?",
    ],
    redFlags: [
      "Rolls back without checking data compatibility.",
      "Assumes the old version can read new rows.",
      "Improvises a data repair during the incident.",
    ],
    rubric: [
      "Checks data compatibility.",
      "Chooses rollback or roll-forward deliberately.",
      "Preserves evidence and data.",
      "Prevents recurrence with schema practice.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Confirm the previous artifact is retained and pullable.",
      "Test the rollback path with the current schema and configuration.",
      "Set the error gate and detection window from the error budget.",
      "Remove manual approvals from the automated path or document the delay.",
      "Record what rollback cannot undo, including data and external side effects.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch per-release errors and the gate's bad-datapoint count.",
      "Confirm the controller has the artifact and permission to deploy it.",
      "Measure detection time and restore time separately.",
      "Stop the rollout manually if the controller cannot act.",
    ],
  },
  {
    title: "After a rollback",
    items: [
      "Verify the previous version is serving and errors have returned to baseline.",
      "Record the time from first bad signal to recovery.",
      "Check for data written by the bad release and decide on compensation.",
      "Update the gate, artifact policy, or runbook with what the incident exposed.",
    ],
  },
];

const references = [
  {
    title: "Roll back deployments",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployments-rollback-and-redeploy.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Automatic rollback triggers, redeployment, and rollback behavior.",
  },
  {
    title: "Amazon ECS deployment circuit breaker",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html",
    publisher: "Amazon ECS",
    kind: "docs" as const,
    note: "Automatic rollback when a deployment fails health checks repeatedly.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Staged rollout, bake time, alarms, and automated rollback as a control loop.",
  },
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release verification, rollback decisions, and the limits of a traffic switch.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rollback-release": {
      model: automatedRollbackModel,
      presets,
      instructions:
        "Start with Healthy, then apply Missing artifact. Compare recovery time with the release error rate. Apply Late gate to isolate detection. Run the experiment to predict exposure, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Error gate, detection windows, recovery target, and missing-artifact multiplier are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-canary-metric-gate",
    "deployment-rollback-vs-rollforward",
    "deployment-rollback-data-loss",
    "deployment-blue-green",
  ],
};
