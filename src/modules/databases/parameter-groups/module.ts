import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "changeType",
    label: "Parameter type",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Change",
    help: "0 for a dynamic parameter that applies without a restart. 1 for a static parameter that needs a reboot.",
    format: "count" as const,
  },
  {
    id: "applyTiming",
    label: "Apply during",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Change",
    help: "0 for an off-peak maintenance window. 1 for peak traffic, where any restart is visible to users.",
    format: "count" as const,
  },
  {
    id: "rollbackPlan",
    label: "Rollback ready",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Change",
    help: "1 keeps the previous parameter group and a tested revert path. 0 applies the change without a quick way back.",
    format: "count" as const,
  },
  {
    id: "settingDelta",
    label: "Query-time change",
    min: -50,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Effect",
    help: "Modeled change in query latency after the setting takes effect. Negative improves latency, positive regresses it.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  isStatic: boolean;
  atPeak: boolean;
  rollback: boolean;
  delta: number;
  downtime: number;
  errorRate: number;
  latencyChange: number;
  regression: number;
  blastRadius: string;
  health: Health;
}

function compute(p: Params): Computed {
  const isStatic = num(p, "changeType", 0) >= 0.5;
  const atPeak = num(p, "applyTiming", 0) >= 0.5;
  const rollback = num(p, "rollbackPlan", 1) >= 0.5;
  const delta = clamp(num(p, "settingDelta", 0), -50, 100);
  const downtime = isStatic ? (atPeak ? 12 : 2) : 0;
  const errorRate = isStatic ? (atPeak ? 8 : 1.5) : 0;
  const regression = Math.max(0, delta);
  const blastRadius = isStatic
    ? atPeak
      ? rollback
        ? "Reboot at peak, with a tested revert"
        : "Reboot at peak, no tested revert"
      : "Reboot in the maintenance window"
    : "Apply in place, no restart";
  const health: Health =
    downtime >= 10 || regression >= 25
      ? "crit"
      : downtime >= 5 || regression >= 10
        ? "warn"
        : "ok";
  return {
    isStatic,
    atPeak,
    rollback,
    delta,
    downtime,
    errorRate,
    latencyChange: delta,
    regression,
    blastRadius,
    health,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["reboot-downtime", values.downtime, 0],
    ["latency-change", values.latencyChange, 0.2],
    ["error-rate", values.errorRate, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const instanceHealth: Health = values.downtime > 0 ? (values.atPeak ? "crit" : "warn") : values.health;
  return {
    t: 0,
    nodes: [
      {
        id: "param-group",
        label: "Custom parameter group",
        kind: "service",
        health: values.health,
        sublabel: values.isStatic ? "static · reboot to apply" : "dynamic · applies in place",
        detail: values.isStatic
          ? "A static parameter is read at startup. Changing it marks the group as pending-reboot until every instance in scope restarts."
          : "A dynamic parameter can be applied to the running engine. The change still has to be compatible with the workload and the other settings.",
        meta: { view: "flow", scope: "instance or cluster" },
      },
      {
        id: "writer",
        label: "Writer instance",
        kind: "db",
        role: "primary",
        health: instanceHealth,
        utilization: clamp(values.regression / 100),
        sublabel: values.downtime > 0 ? `${values.downtime} min restart` : "no restart",
        detail:
          "The writer takes the change first if it is the canary. A reboot drops connections and, during peak, turns a configuration change into an outage.",
        meta: { view: "flow" },
      },
      {
        id: "reader",
        label: "Reader instance",
        kind: "db",
        role: "replica",
        health: values.isStatic && values.atPeak ? "warn" : "ok",
        sublabel: values.isStatic ? "pending reboot" : "dynamic apply",
        detail:
          "Apply to a reader or a staging copy first. The reader can reveal a plan regression without putting the writer at risk, but it still has to run the same workload.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("group-writer", "param-group", "writer", 0.8, instanceHealth, "apply"),
      edge("group-reader", "param-group", "reader", 0.6, values.health, "apply"),
    ],
    metrics: [
      metric("reboot-downtime", "Restart downtime", values.downtime, " min", 5, 10, "number"),
      metric("latency-change", "Query latency regression", values.regression, "%", 10, 25, "percent"),
      metric("error-rate", "Client error rate", values.errorRate, "%", undefined, undefined, "percent"),
      metric("blast-radius", "Blast radius", values.downtime > 0 ? (values.atPeak ? 3 : 1) : 0, " inst", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.blastRadius}; restart ${values.downtime} min; latency ${values.latencyChange}%; errors ${values.errorRate}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "reboot-downtime",
    metricId: "reboot-downtime",
    warn: 5,
    crit: 10,
    title: "A parameter change is causing a restart outage",
    cause:
      "A static parameter only takes effect at startup. Applying it to a live instance requires a reboot, which drops connections and can move the writer if the deployment is Multi-AZ.",
    fix:
      "Apply static changes in a maintenance window, one instance at a time, with the previous parameter group ready to restore. Test the setting on a canary first.",
    checkFirst: [
      "Check whether the parameter is dynamic or static in the engine's parameter table.",
      "Check which instances or cluster members are in the group's scope.",
      "Check the maintenance window and the application's reconnect behavior.",
    ],
  },
  {
    id: "latency-change",
    metricId: "latency-change",
    warn: 10,
    crit: 25,
    title: "The setting regressed query latency",
    cause:
      "A parameter that helps one query shape can hurt another. Work memory, planner costs, parallelism, and timeouts interact, and the effect appears only under the production mix.",
    fix:
      "Revert the value or attach the previous group, compare plans and wait events on the affected queries, and re-test on a canary with the full workload.",
    checkFirst: [
      "Compare p50 and p99 by query shape before and after the change.",
      "Check whether the setting changed memory, parallelism, or planner costs.",
      "Check whether the rollback group is still available and tested.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const parameterModel: SimModel = {
  id: "databases-parameter-groups",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.isStatic && values.atPeak && frame.flags.rebootLogged !== 1) {
      pushEvent(next, {
        id: "static-change-at-peak",
        at: frame.t,
        severity: "crit",
        title: "Static parameter scheduled during peak",
        detail: `The group needs a ${values.downtime}-minute restart and the application sees about ${values.errorRate}% errors while connections drop.`,
        nodeId: "writer",
        metricId: "reboot-downtime",
      });
    }
    next.flags.rebootLogged = values.isStatic && values.atPeak ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      values.isStatic
        ? "The change is static: the engine reads it at startup, so the group remains pending-reboot until every instance in scope restarts."
        : "The change is dynamic: it applies to the running engine without a restart. That removes the reboot risk but not the regression risk.",
      values.atPeak
        ? `Applying at peak makes the ${values.downtime}-minute restart visible: connections drop and the error rate is about ${values.errorRate}%.`
        : "Applying in a maintenance window keeps the restart away from peak, but it still drops connections and still needs a rollback path.",
      `The modeled latency change is ${values.latencyChange}%. A value that improves one query can regress another; ${values.regression}% is the regression part that matters for the alert.`,
      values.rollback
        ? "A tested rollback means the previous parameter group can be restored quickly. The restart may still be needed, but the time to a known-good configuration is shorter."
        : "Without a tested rollback, a regression turns into an investigation while the new setting stays in production.",
      "Cluster-level parameters apply to the whole Aurora cluster; instance-level parameters apply per instance. A cluster parameter can change behavior for every reader, not just the canary.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A dynamic setting applied off-peak with a tested rollback and no latency change.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Dynamic at peak",
    description: "A dynamic change applies without a restart but regresses query latency by 15%.",
    tone: "warn",
    params: defaults({ changeType: 0, applyTiming: 1, rollbackPlan: 1, settingDelta: 15 }),
  },
  {
    id: "failure",
    label: "Static at peak",
    description: "A static parameter needs a 12-minute restart during peak traffic and has no tested rollback.",
    tone: "crit",
    params: defaults({ changeType: 1, applyTiming: 1, rollbackPlan: 0, settingDelta: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A dynamic change applies in place off-peak, with a rollback ready and a 5% latency cost.",
    tone: "ok",
    params: defaults({ changeType: 0, applyTiming: 0, rollbackPlan: 1, settingDelta: 5 }),
  },
];

const experiment: Experiment = {
  id: "plan-the-rollout",
  title: "Roll out a setting that helps and hurts",
  simId: "parameter-groups",
  question:
    "A parameter change makes reporting faster but adds 30% latency to checkout. It is a static parameter. What is the safest rollout?",
  prediction: {
    options: [
      { id: "prod-now", label: "Apply it to the production group immediately and watch checkout." },
      { id: "canary", label: "Test it in a custom group on a canary with the real workload, then schedule the reboot off-peak with a rollback." },
      { id: "restart-all", label: "Reboot every instance at once so the change is consistent." },
      { id: "bigger", label: "Increase the instance size so the latency regression is absorbed." },
    ],
    correctOptionId: "canary",
    explanation:
      "A static parameter needs a restart, so the change has both a regression risk and an availability risk. A canary on the real workload shows which query shapes improve and which regress. Only then should the reboot be scheduled off-peak, one instance at a time, with the previous group ready. Applying at peak or rebooting everything at once turns a configuration change into an outage.",
  },
  setup: defaults({ changeType: 1, applyTiming: 1, rollbackPlan: 0, settingDelta: 40 }),
  runFor: 20,
  observe: [
    "Restart downtime is 12 minutes and the client error rate is about 8%.",
    "The query latency change is +40%, so checkout regresses at the same time.",
    "The writer is critical and the reader is pending reboot.",
    "There is no tested rollback, so the time to a known-good setting is longer.",
  ],
  explain:
    "The apply mode and the setting's effect are separate risks. The static parameter forces a restart; the setting's value forces a performance change. A safe plan tests the value on a canary, then schedules the restart in a maintenance window with the old group ready. Rebooting everything at once only makes the availability risk larger.",
  fix: defaults({ changeType: 1, applyTiming: 0, rollbackPlan: 1, settingDelta: 5 }),
  debrief:
    "With the change tested and the reboot moved off-peak, downtime falls to about 2 minutes and the regression to 5%. The restart is still visible, but it is bounded and reversible. The rollback group is what limits the time to recover if the canary missed a query shape.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A parameter group is a named collection of engine settings. In Amazon RDS and Aurora, you attach it to an instance or a cluster; changing a value changes how the engine behaves without changing the application code. PostgreSQL exposes the same idea as settings in postgresql.conf and per-session SET commands.",
  },
  {
    type: "p",
    text: "Parameters come in two apply modes. A dynamic parameter can be changed on a running engine and takes effect without a restart. A static parameter is read at startup, so the group stays pending-reboot until the instance restarts. The distinction matters because a restart drops connections, and during peak that is an outage, not a maintenance step.",
  },
  {
    type: "p",
    text: "Scope is the second distinction. In Aurora, cluster-level parameters apply to the whole cluster; instance-level parameters apply to one instance. A change that looks small on a canary can affect every reader if it lives at cluster scope. Check both the apply mode and the scope before you plan the rollout.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The parameter group sits between the engine and the workload. The engine reads the value at startup or when it is applied; the planner, memory allocator, and connection handling then behave differently. The application does not see the group directly, only the plans, latency, and errors that result.",
  },
  {
    type: "table",
    headers: ["Change", "Apply path", "Main risk"],
    rows: [
      ["Dynamic, instance scope", "Apply in place", "Plan or memory regression"],
      ["Static, instance scope", "Reboot the instance", "Connection drop and failover"],
      ["Dynamic, cluster scope", "Apply to the cluster", "Every reader changes at once"],
      ["Static, cluster scope", "Reboot cluster members", "Wide restart and long recovery"],
      ["Unknown scope", "Stop and read the docs", "A surprise blast radius"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Restart downtime: warning at 5 minutes and critical at 10 in this model.",
      "Query latency change: warning at +10% and critical at +25%.",
      "Client error rate during the restart, which follows the dropped connections.",
      "Blast radius: the number of instances affected by the apply path.",
      "A static/dynamic toggle and an apply-timing toggle, which change the risk independently.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Static at peak. Read restart downtime before the latency change. Move the same change to the maintenance window and add a rollback to see which risk each control removes. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Restart times, error rates, and latency changes are illustrative teaching values. Real apply modes and scope depend on the engine and the specific parameter; check the parameter table for your version rather than assuming a setting is dynamic.",
  },
  { type: "sim", simId: "parameter-groups" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The static parameter could not take effect on the running engine. It marked the group pending-reboot, and applying it during peak forced a 12-minute restart that dropped connections and produced about 8% errors. At the same time, the setting itself regressed checkout latency by 40%. Two risks arrived together because the plan treated the change as one event.",
  },
  {
    type: "p",
    text: "Testing the value on a canary separated the performance question from the availability question. Moving the reboot to a maintenance window and keeping the previous group ready reduced downtime to about 2 minutes and the regression to 5%. The restart was still real, but it was bounded and reversible.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The parameter group's pending-reboot status and the apply status of each parameter.",
      "RDS events for reboot, failover, and parameter group changes, with timestamps.",
      "Application error rates and connection-pool reconnect counts at the moment of the restart.",
      "Query latency by statement from Performance Insights or pg_stat_statements before and after.",
      "Cluster-level versus instance-level group membership, which determines the blast radius.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the parameter's apply mode and scope before you schedule anything. If it is static, the restart is part of the change. If the latency regressed, compare plans and wait events by query shape, and restore the previous group before investigating at leisure.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Look up the parameter in the engine's parameter table: dynamic or static, and instance or cluster scope.",
      "Clone the current group, change one parameter, and attach it to a canary with production-like traffic.",
      "Compare latency and plans by query shape, not just the database average.",
      "Schedule a static reboot in a maintenance window, one instance at a time, with a tested reconnect path.",
      "Keep the previous parameter group ready and rehearse the revert before the change.",
      "Record the values, the canary result, and the rollback trigger in the change ticket.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A canary catches regressions but costs time and a second environment, and it may not reproduce the full workload.",
      "A maintenance window reduces user impact but delays a fix that might be urgent.",
      "A dynamic change avoids the restart but can still regress plans and memory use.",
      "A cluster-level change is consistent across readers but has a wider blast radius.",
      "Frequent parameter tuning adds operational risk; every change needs a rollback and a measurement plan.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "dynamic-static",
    question: "How do you know whether a parameter change needs a reboot?",
    difficulty: 2,
    hints: [
      "The parameter table documents the apply mode.",
      "The group reports pending-reboot.",
    ],
    answer:
      "I would check the engine's parameter table for the parameter's apply type. A dynamic parameter applies to a running instance; a static parameter is read at startup and leaves the group pending-reboot until the instance restarts. On RDS and Aurora, the console and API show the apply status and pending-reboot flag. I would confirm the scope as well, because a cluster-level parameter can affect every member even if the canary looked fine.",
    followUps: [
      "What does pending-reboot mean for the other parameters?",
      "How would you apply a static change with minimal downtime?",
      "What would you check after the reboot?",
    ],
    redFlags: [
      "Assumes every parameter is dynamic.",
      "Ignores cluster scope.",
      "Reboots everything at once.",
    ],
    rubric: [
      "Names the apply type.",
      "Mentions pending-reboot.",
      "Checks scope.",
      "Plans a staged restart.",
    ],
  },
  {
    id: "rollout-plan",
    question: "Walk through a safe rollout for a static parameter that improves reporting but may hurt checkout.",
    difficulty: 3,
    hints: [
      "Separate the value test from the restart.",
      "Keep a revert path.",
    ],
    answer:
      "I would clone the group and change one parameter, then attach it to a canary or a staging copy that runs both reporting and checkout traffic. I would compare p50 and p99 by query shape and check plans and wait events. If the value is acceptable, I would schedule the restart in a maintenance window, one instance at a time, with the previous group ready and a rollback trigger defined. After the change I would watch the same query shapes and the connection-pool error rate.",
    followUps: [
      "What would make you abandon the change?",
      "How would you handle a Multi-AZ failover during the reboot?",
      "What belongs in the change ticket?",
    ],
    redFlags: [
      "Applies directly to production.",
      "Tests only the reporting query.",
      "Has no rollback trigger.",
    ],
    rubric: [
      "Tests on a canary.",
      "Checks both query shapes.",
      "Schedules the restart off-peak.",
      "Defines rollback.",
    ],
  },
  {
    id: "cluster-scope",
    question: "A cluster-level parameter improved the writer but broke a reader. How is that possible?",
    difficulty: 3,
    hints: [
      "The reader runs the same engine with a different role and workload.",
      "Cluster scope reaches every member.",
    ],
    answer:
      "Cluster-level parameters apply to the whole cluster, so the change reached the reader even though the writer was the intended target. The reader may have a different workload, cache state, or resource profile, so the same setting can help one member and hurt another. I would check whether the parameter should be instance-level instead, compare the reader's plans and wait events, and revert the cluster value if the reader's regression is real.",
    followUps: [
      "When is cluster scope the right choice?",
      "How would you test a cluster-level change?",
      "What does this imply for rollback?",
    ],
    redFlags: [
      "Assumes all members behave the same.",
      "Changes cluster scope without a canary.",
      "Ignores reader workload.",
    ],
    rubric: [
      "Explains cluster scope.",
      "Names workload differences.",
      "Considers instance scope.",
      "Reverts safely.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every proposed change names the parameter's apply mode and scope.",
      "The current group is cloned and the previous version is retained.",
      "A canary runs production-like reporting and transactional traffic.",
      "The maintenance window and reconnect behavior are documented.",
      "A rollback trigger and owner are assigned before the change.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check pending-reboot and the apply status of each member.",
      "Watch error rate and connection reconnects during any restart.",
      "Compare latency by query shape, not just the database average.",
      "Revert to the previous group if the regression crosses the trigger.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the canary result, the applied values, and the rollback time.",
      "Remove stale custom groups and document the surviving settings.",
      "Re-test the change under the next peak if it is performance-sensitive.",
      "Update the parameter review with what the canary missed.",
    ],
  },
];

const references = [
  {
    title: "Working with parameter groups for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithParamGroups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Creating and attaching parameter groups, apply types, and the pending-reboot state.",
  },
  {
    title: "Working with parameter groups for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/USER_WorkingWithParamGroups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cluster-level and instance-level parameter groups and how changes apply.",
  },
  {
    title: "PostgreSQL: Setting Parameters",
    url: "https://www.postgresql.org/docs/current/config-setting.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Parameter context, reload versus restart, and per-session versus server-wide settings.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "parameter-groups": {
      model: parameterModel,
      presets,
      instructions:
        "Start healthy, apply Static at peak, and read restart downtime before latency. Move the same change to a maintenance window and add a rollback. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Restart times, error rates, and latency changes are teaching values; check the parameter table for the real apply mode.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-rds-proxy",
    "databases-failover-dns",
    "deployment-canary",
  ],
};
