import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "deployNow",
    label: "Deploy during the incident (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Decision",
    help: "One means the fix is deployed to production while the incident is active. Zero means the team uses a reversible change or waits.",
    format: "count",
  },
  {
    id: "fixConfidence",
    label: "Confidence the fix addresses the cause",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Decision",
    help: "How strongly the evidence supports this fix as the cause, rather than a plausible change made under pressure.",
    format: "percent",
  },
  {
    id: "rollbackPrepared",
    label: "Rollback prepared (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Safety",
    help: "One means the previous artifact and configuration are available and a rollback has been tested. Zero means restoring service is improvised.",
    format: "count",
  },
  {
    id: "changeScope",
    label: "Services touched by the change",
    min: 1,
    max: 20,
    step: 1,
    value: 1,
    unit: " services",
    group: "Scope",
    help: "How many services, shared libraries, or configuration domains the change modifies. Wider scope adds more diagnostic variables.",
    format: "count",
  },
  {
    id: "incidentErrorRate",
    label: "Current incident error rate",
    min: 0,
    max: 20,
    step: 0.5,
    value: 5,
    unit: "%",
    group: "Incident",
    help: "The error rate users are experiencing before the change. This is the baseline the fix must improve.",
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
  deploy: boolean;
  confidence: number;
  rollback: boolean;
  scope: number;
  variables: number;
  errorRate: number;
  mitigationMinutes: number;
}

function compute(p: Params): Values {
  const deploy = num(p, "deployNow", 0) >= 0.5;
  const confidence = clamp(num(p, "fixConfidence", 90), 0, 100);
  const rollback = num(p, "rollbackPrepared", 1) >= 0.5;
  const scope = Math.max(1, Math.round(num(p, "changeScope", 1)));
  const incidentError = clamp(num(p, "incidentErrorRate", 5), 0, 20);

  const variables = deploy ? scope : 0;
  const errorRate = Math.min(
    30,
    incidentError * (deploy ? 1 - (confidence / 100) * 0.7 : 1) + (deploy && !rollback ? 3 : 0),
  );
  const mitigationMinutes = (deploy ? 10 : 20) + (rollback ? scope * 2 : 40 + scope * 4);

  return { deploy, confidence, rollback, scope, variables, errorRate, mitigationMinutes };
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
  const variableHealth = highHealth(values.variables, 2, 6);
  const errorHealth = highHealth(values.errorRate, 1, 5);
  const mitigationHealth = highHealth(values.mitigationMinutes, 30, 60);
  const serviceHealth = worst(variableHealth, errorHealth);

  const stageNodes = [
    {
      id: "incident",
      label: "Affected service",
      kind: "service" as const,
      health: errorHealth,
      utilization: clamp(values.errorRate / 20),
      sublabel: `${percent(values.errorRate)} errors · incident active`,
      detail: `Users see ${percent(values.errorRate)} errors. The incident is not resolved; the question is whether a production change improves the signal or adds noise.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "fix",
      label: "Fix candidate",
      kind: "service" as const,
      health: worst(variableHealth, errorHealth),
      utilization: clamp(values.variables / 10),
      sublabel: values.deploy ? `${values.scope} services · ${percent(values.confidence)} confidence` : "held back",
      detail: values.deploy
        ? `The fix touches ${values.scope} service${values.scope === 1 ? "" : "s"} with ${percent(values.confidence)} confidence. Every touched surface is a new variable in the diagnosis.`
        : "The fix is not deployed. The team can still use a reversible config change, a flag, or further diagnosis.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "rollback",
      label: "Rollback path",
      kind: "service" as const,
      health: mitigationHealth,
      utilization: clamp(values.mitigationMinutes / 120),
      sublabel: values.rollback ? `prepared · ${values.mitigationMinutes.toFixed(0)} min` : "not prepared · improvised",
      detail: `The modeled mitigation path takes ${values.mitigationMinutes.toFixed(0)} minutes. A prepared rollback bounds the blast radius of a change that does not help.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "alert", label: "Incident", kind: "client" as const, health: errorHealth, meta: { view: "flow" } },
    {
      id: "service-flow",
      label: "Production service",
      kind: "service" as const,
      health: serviceHealth,
      sublabel: `${percent(values.errorRate)} errors`,
      meta: { view: "flow" },
    },
    {
      id: "change",
      label: "Change under test",
      kind: "worker" as const,
      health: variableHealth,
      sublabel: values.deploy ? `${values.variables} diagnostic variables` : "not applied",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("alert-service", "alert", "service-flow", clamp(values.errorRate / 20), errorHealth),
      edge("change-service", "change", "service-flow", clamp(values.variables / 20), variableHealth),
    ],
    metrics: [
      metric("diagnostic-variables", "Diagnostic variables added", values.variables, " vars", 2, 6, "count"),
      metric("service-errors", "Service error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("mitigation-minutes", "Mitigation path", values.mitigationMinutes, "min", 30, 60, "number"),
      metric("fix-confidence", "Fix confidence", values.confidence, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), variables: values.variables },
    summary: `${values.variables} diagnostic variables · ${percent(values.errorRate)} errors · mitigation ${values.mitigationMinutes.toFixed(0)} min`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 4)) / 2.1);
  for (const [id, value] of [
    ["diagnostic-variables", values.variables],
    ["service-errors", values.errorRate],
    ["mitigation-minutes", values.mitigationMinutes],
    ["fix-confidence", values.confidence],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "diagnostic-variables",
    metricId: "diagnostic-variables",
    warn: 2,
    crit: 6,
    title: "The change adds too many diagnostic variables",
    cause: "A broad deploy during an incident changes several services or shared components at once. When the signal moves, the team cannot tell whether the fix worked, the change introduced a new fault, or traffic shifted.",
    fix: "Stop and narrow the change to one reversible surface. If the broad deploy is already live, preserve its timeline and roll it back before testing another hypothesis. Prefer a flag or config change that can be reversed in seconds.",
    checkFirst: [
      "List every service, library, and config domain the change touched.",
      "Check whether the error signal changed at the deploy time or before it.",
      "Check whether the rollback is tested and can run without a rebuild.",
    ],
  },
  {
    id: "service-errors",
    metricId: "service-errors",
    warn: 1,
    crit: 5,
    title: "The incident is still failing users",
    cause: "The change did not address the cause, the cause is still unknown, or the incident has a second failure mode. Pressure to act can produce a deploy that adds risk without improving the user signal.",
    fix: "Return to the incident command process. Stabilize with a reversible mitigation, preserve evidence, and test one hypothesis at a time. Roll back a change that did not improve the signal.",
    checkFirst: [
      "Compare the error rate before and after the change.",
      "Check whether the affected dependency or traffic mix changed.",
      "Check whether the fix targeted a symptom rather than the cause.",
    ],
  },
  {
    id: "mitigation-minutes",
    metricId: "mitigation-minutes",
    warn: 30,
    crit: 60,
    title: "The mitigation path is too slow",
    cause: "The previous artifact is unavailable, the rollback was never tested, or the change touches too many services. Under incident pressure, an improvised path extends user impact.",
    fix: "Prepare and test rollback before the incident. Keep the previous artifact and configuration available. If no safe path exists, stabilize with a reversible flag change rather than a broad deploy.",
    checkFirst: [
      "Check whether the previous artifact and config are available.",
      "Check who can authorize and execute the rollback.",
      "Check the time a rollback took in the last drill.",
    ],
  },
];

export const incidentDeployModel: SimModel = {
  id: "deployment-incident-deploy",
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
      values.deploy
        ? `The fix is deployed while the incident is active, touching ${values.scope} service${values.scope === 1 ? "" : "s"}.`
        : "No production deploy is in flight. The incident remains, but the diagnosis has fewer variables.",
    );
    items.push(
      `Fix confidence is ${percent(values.confidence)}. Confidence is a hypothesis, not evidence that the change will help.`,
    );
    items.push(
      `The modeled mitigation path is ${values.mitigationMinutes.toFixed(0)} minutes with ${values.rollback ? "a prepared rollback" : "no prepared rollback"}.`,
    );
    items.push(
      `Service errors are ${percent(values.errorRate)}. A change that does not move this signal should be rolled back rather than layered with another change.`,
    );
    return items;
  },
  legend: [
    { label: "Stable", tone: "ok" },
    { label: "More variables", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A small incident, no production deploy, and a prepared rollback path.",
    tone: "ok",
    params: defaults({ deployNow: 0, fixConfidence: 90, rollbackPrepared: 1, changeScope: 1, incidentErrorRate: 0.8 }),
  },
  {
    id: "peak",
    label: "Narrow deploy",
    description: "A three-service fix with moderate confidence and a prepared rollback.",
    tone: "warn",
    params: defaults({ deployNow: 1, fixConfidence: 70, rollbackPrepared: 1, changeScope: 3, incidentErrorRate: 3 }),
  },
  {
    id: "failure",
    label: "Broad deploy",
    description: "Fifteen services change with low confidence, no tested rollback, and a live incident.",
    tone: "crit",
    params: defaults({ deployNow: 1, fixConfidence: 20, rollbackPrepared: 0, changeScope: 15, incidentErrorRate: 5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A narrow, high-confidence fix with a prepared rollback and a small residual error rate.",
    tone: "ok",
    params: defaults({ deployNow: 1, fixConfidence: 95, rollbackPrepared: 1, changeScope: 1, incidentErrorRate: 1 }),
  },
  {
    id: "flag-first",
    label: "Flag first",
    description: "No deploy, but the incident is still failing until a reversible flag change is applied.",
    tone: "crit",
    params: defaults({ deployNow: 0, fixConfidence: 95, rollbackPrepared: 1, changeScope: 1, incidentErrorRate: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-incident-change",
  title: "Predict the safest change during an incident",
  simId: "incident-deploy",
  question:
    "An incident is active, the cause is uncertain, and an engineer has a broad code fix ready. What is the safest next move?",
  prediction: {
    options: [
      { id: "reversible", label: "Use a reversible config or flag change tied to one hypothesis" },
      { id: "broad", label: "Deploy the broad fix now to cover every possible cause" },
      { id: "wait", label: "Wait for the incident to end before changing anything" },
      { id: "stack", label: "Deploy several fixes together to save time" },
    ],
    correctOptionId: "reversible",
    explanation:
      "An incident change should reduce uncertainty or user impact without adding many new variables. A reversible config or flag change tied to one stated hypothesis can be tested and undone quickly. A broad or stacked deploy may help, but it destroys the ability to attribute the next signal.",
  },
  setup: defaults({ deployNow: 1, fixConfidence: 20, rollbackPrepared: 0, changeScope: 15, incidentErrorRate: 5 }),
  runFor: 30,
  observe: [
    "Fifteen diagnostic variables are added at once.",
    "Service errors rise to 7.3% because the change does not address the cause and has no prepared rollback.",
    "The mitigation path takes 110 minutes.",
    "The original incident signal is now mixed with the change signal.",
  ],
  explain:
    "The problem is not that deploying during an incident is always wrong. The problem is a broad, low-confidence change with no rollback. It adds variables faster than the team can interpret them, and it removes the clean baseline needed to tell whether the incident is improving.",
  fix: defaults({ deployNow: 1, fixConfidence: 95, rollbackPrepared: 1, changeScope: 1, incidentErrorRate: 2 }),
  debrief:
    "The fixed state deploys one service with high confidence and a prepared rollback, and the modeled error rate falls below the threshold. The tradeoff is that a narrow fix may take longer to prepare. That delay is usually cheaper than losing the ability to diagnose the incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Deploying during an incident means changing production while users are already affected and the cause may not be fully understood. Sometimes that is correct: a known bad release is rolled back, or a single configuration value restores service. The risk is that the change adds variables to an unstable system, and the team loses the ability to tell what helped, what hurt, and what was already broken.",
  },
  {
    type: "p",
    text: "The safer default is the smallest reversible change that tests one hypothesis. A flag or configuration change can often be applied and reversed in seconds without rebuilding an artifact. A broad code deploy touches multiple services, takes longer to roll back, and makes the timeline harder to read. The decision is not deploy versus do nothing; it is which change reduces uncertainty or impact with the least new risk.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Incident command owns the decision and the timeline. The deploy pipeline, flag system, and rollback controller are the tools. Before a change, the team states the hypothesis, the signal expected to move, the time window, and the rollback condition. After the change, the timeline records the deploy and the signal at that timestamp. Without that record, a later responder cannot separate the original failure from the change.",
  },
  {
    type: "p",
    text: "The error rates, service counts, and mitigation times here are illustrative. The structure is what matters: diagnostic variables grow with scope, and mitigation time grows when rollback is improvised. A prepared rollback is what makes a change safe to try.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Diagnostic variables: the number of services or surfaces the change touched.",
      "Service error rate: the user signal before and after the change.",
      "Mitigation path: how long it takes to restore service if the change fails.",
      "Fix confidence: the strength of evidence for the hypothesis, not a guarantee.",
      "Nodes for the affected service, the fix candidate, and the rollback path.",
    ],
  },
  {
    type: "table",
    headers: ["Change", "Time to reverse", "Variables added", "When it fits"],
    rows: [
      ["Flag toggle", "Seconds", "One behavior", "Feature or path can be disabled"],
      ["Config change", "Seconds to minutes", "One value", "Known bad setting with a safe alternative"],
      ["Single-service deploy", "Minutes", "One artifact", "Cause is localized and rollback is ready"],
      ["Broad multi-service deploy", "Tens of minutes", "Many", "Rarely justified mid-incident"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Narrow deploy: variables enter the warning band. Apply Broad deploy to see errors, variables, and mitigation time rise together. Apply Flag first to see that avoiding a deploy does not fix the incident by itself. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "incident-deploy" },
  { type: "experiment", experimentId: "predict-incident-change" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, a 15-service deploy ran with 20% confidence and no prepared rollback. It added 15 diagnostic variables, errors rose to 7.3%, and the mitigation path took 110 minutes. The change did not reduce the incident; it made the timeline ambiguous.",
  },
  {
    type: "p",
    text: "The flag-first preset shows the opposite mistake: no deploy, but the incident continued at 5% errors. Not changing production is not a mitigation. The useful path is a reversible change tied to a hypothesis, with the rollback ready before the change starts.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A deploy timestamp in the middle of the incident timeline with no clear signal change.",
      "New errors that start after the change and are hard to separate from the original fault.",
      "A rollback that requires a rebuild or a coordinated multi-service revert.",
      "On-call engineers unsure which version is running on which fleet.",
      "A postmortem that cannot attribute the recovery to a specific action.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask what hypothesis the change tests and which signal should move. Check the scope and the rollback time before approving it. If the change touches several services or cannot be reversed quickly, narrow it or use a flag. Record the deploy time on the incident timeline.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "State the hypothesis and the signal that would confirm or reject it.",
      "Prefer a flag or config change that can be reversed without a deploy.",
      "Limit the change to one service or one behavior.",
      "Confirm the rollback path and who can execute it.",
      "Record the change time and watch the signal for a defined window.",
      "Roll back a change that does not improve the signal before trying another.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A narrow reversible change preserves diagnosis but may not fix a broad failure.",
      "A fast broad deploy can restore service in rare cases, at the cost of attribution and rollback complexity.",
      "Waiting for certainty avoids new risk but extends user impact when the cause is already clear.",
      "A flag kill switch is fast but may not cover a data or dependency failure.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "deploy-now",
    question:
      "An incident is active and an engineer has a fix ready. What do you ask before approving a production deploy?",
    difficulty: 3,
    hints: [
      "What is the hypothesis?",
      "What will you watch, and for how long?",
      "How fast can you undo it?",
    ],
    answer:
      "I would ask what evidence supports the cause, which signal should move if the fix is right, how many services the change touches, and how quickly it can be rolled back. I would prefer a flag or config change if it can test the same hypothesis. I would also ask what happens if the signal does not move and who owns the decision. If those answers are weak, I would stabilize and keep diagnosing rather than deploy broadly.",
    followUps: [
      "When would you approve a broad deploy mid-incident?",
      "What if the fix is ready but the rollback is not?",
      "How do you record the change on the incident timeline?",
    ],
    redFlags: ["Approves because the fix is ready.", "Has no expected signal.", "Does not check rollback."],
    rubric: ["Requires a hypothesis.", "Prefers reversibility.", "Bounds scope.", "Defines rollback and observation."],
  },
  {
    id: "lost-cause",
    question:
      "A deploy during the incident made things worse and the team cannot tell why. What now?",
    difficulty: 3,
    hints: [
      "Stabilize first.",
      "Roll back the newest variable when safe.",
      "Preserve the timeline.",
    ],
    answer:
      "I would stop adding changes and roll back the deploy if it is safe and the previous artifact is available. I would preserve the deploy timeline, version per fleet, error signals, and logs from before and after the change. If rollback is unsafe, I would disable the changed path with a flag. Once users are stable, I would reconstruct the timeline and test one hypothesis at a time.",
    followUps: [
      "What if the rollback itself is risky?",
      "Which evidence do you preserve first?",
      "How do you communicate the added uncertainty?",
    ],
    redFlags: ["Deploys another fix immediately.", "Deletes the evidence.", "Ignores version spread."],
    rubric: ["Stabilizes first.", "Rolls back or disables.", "Preserves evidence.", "Resumes one hypothesis at a time."],
  },
  {
    id: "reversible",
    question: "Why is a flag change usually safer than a code deploy during an incident?",
    difficulty: 2,
    hints: [
      "Time to reverse.",
      "Number of changed surfaces.",
      "Blast radius of a mistake.",
    ],
    answer:
      "A flag change alters one behavior and can usually be reversed in seconds without rebuilding or rescheduling. A code deploy changes an artifact, may touch several services, takes time to roll out, and can fail in new ways during the rollout. The flag still needs a hypothesis and a kill switch, but it adds fewer variables and has a shorter recovery path.",
    followUps: [
      "When is a flag change not enough?",
      "What risks does a flag change carry?",
      "How do you test the kill switch?",
    ],
    redFlags: ["Assumes flags are always safe.", "Ignores flag-provider failure.", "Has no hypothesis."],
    rubric: ["Compares reversal time.", "Compares scope.", "States flag risks.", "Requires a hypothesis."],
  },
  {
    id: "postmortem",
    question: "How should the postmortem treat a deploy that happened during the incident?",
    difficulty: 2,
    hints: [
      "It is part of the timeline.",
      "Judge the decision with the information available.",
      "Fix the process, not just the individual change.",
    ],
    answer:
      "The deploy belongs on the timeline with its time, scope, expected signal, and observed effect. The review should separate the original cause from any new impact and ask whether the decision process supported a reversible, narrow change. It should also check whether rollback was ready and whether the team could see the effect. The outcome is a process change, such as a flag-first path or a smaller change template, not blame for acting under pressure.",
    followUps: [
      "What if the deploy shortened the incident?",
      "How do you review a decision made with incomplete information?",
      "Which process change would you prioritize?",
    ],
    redFlags: ["Leaves the deploy off the timeline.", "Blames the responder.", "Only fixes the code."],
    rubric: ["Includes the change in the timeline.", "Separates causes.", "Reviews the decision process.", "Changes the system."],
  },
];

const checklist = [
  {
    title: "Before changing production",
    items: [
      "State the hypothesis and the signal expected to move.",
      "Choose the smallest reversible change that tests it.",
      "Confirm the previous artifact and configuration are available.",
      "Assign the rollback owner and define the observation window.",
    ],
  },
  {
    title: "During the change",
    items: [
      "Record the change time on the incident timeline.",
      "Watch the expected signal and the overall error rate.",
      "Stop adding changes if the signal does not move.",
      "Roll back a change that makes the incident harder to read.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Separate original cause from change impact in the review.",
      "Verify the fleet is on the intended version.",
      "Update the runbook with the reversible path that worked.",
      "Add any missing signal or rollback test.",
    ],
  },
];

const references = [
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident command, clear roles, and controlled change under pressure.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Reversible releases, rollout control, and rollback paths.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "incident-deploy": {
      model: incidentDeployModel,
      presets,
      instructions:
        "Start with Healthy, then apply Narrow deploy. Apply Broad deploy to see variables, errors, and mitigation time rise. Apply Flag first to see the cost of no mitigation. Run the experiment and apply its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Error rates, service counts, and mitigation times are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-rollback-vs-rollforward", "deployment-feature-flags", "deployment-automated-rollback", "deployment-rollback-data-loss"],
};
