import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "panelCount",
    label: "Panel count",
    min: 4,
    max: 40,
    step: 1,
    value: 8,
    unit: " panels",
    group: "Layout",
    help: "How many panels the on-call engineer scans before reaching a decision.",
    format: "count",
  },
  {
    id: "keyPanelRank",
    label: "Key signal position",
    min: 1,
    max: 20,
    step: 1,
    value: 1,
    unit: "",
    group: "Layout",
    help: "Position of the error and canary panel in reading order. Position 1 is above the fold; values above the panel count are clamped.",
    format: "count",
  },
  {
    id: "thresholdCoverage",
    label: "Threshold coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Legibility",
    help: "Share of decision-critical panels with a threshold and a clear good or bad state.",
    format: "percent",
  },
  {
    id: "annotationDensity",
    label: "Annotation density",
    min: 0,
    max: 12,
    step: 1,
    value: 1,
    unit: " /h",
    group: "Legibility",
    help: "Deploy, incident, and maintenance annotations per hour. Useful context becomes noise at high density.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  panelCount: number;
  keyPanelRank: number;
  thresholdCoverage: number;
  annotationDensity: number;
  timeToAnswer: number;
  thresholdGap: number;
  canaryError: number;
  stableError: number;
}

function compute(p: Params): Computed {
  const panelCount = Math.round(num(p, "panelCount", 8));
  const keyPanelRank = Math.min(panelCount, Math.round(num(p, "keyPanelRank", 1)));
  const thresholdCoverage = num(p, "thresholdCoverage", 100);
  const annotationDensity = num(p, "annotationDensity", 1);
  const timeToAnswer =
    8 +
    panelCount +
    Math.max(0, keyPanelRank - 1) * 5 +
    (100 - thresholdCoverage) * 0.45 +
    annotationDensity * 3.5;
  return {
    panelCount,
    keyPanelRank,
    thresholdCoverage,
    annotationDensity,
    timeToAnswer,
    thresholdGap: 100 - thresholdCoverage,
    canaryError: 2.4,
    stableError: 0.2,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function combine(...values: ("ok" | "warn" | "crit")[]): "ok" | "warn" | "crit" {
  if (values.includes("crit")) return "crit";
  if (values.includes("warn")) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.5);
  const seeds: [string, number, number][] = [
    ["time-to-answer", values.timeToAnswer, 1.5],
    ["canary-error", values.canaryError, 0.02],
    ["stable-error", values.stableError, 0.01],
    ["panels", values.panelCount, 0.1],
    ["key-panel-rank", values.keyPanelRank, 0.1],
    ["threshold-gap", values.thresholdGap, 0.3],
    ["annotation-density", values.annotationDensity, 0.05],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const timeHealth = healthFor(values.timeToAnswer, 60, 120);
  const scanHealth = healthFor(values.panelCount, 16, 24);
  const rankHealth = healthFor(values.keyPanelRank, 6, 12);
  const coverageHealth = healthFor(values.thresholdGap, 25, 50);
  const annotationHealth = healthFor(values.annotationDensity, 3, 6);
  const decisionHealth = combine(
    timeHealth,
    scanHealth,
    rankHealth,
    coverageHealth,
    annotationHealth,
  );
  return {
    t: 0,
    nodes: [
      {
        id: "alert",
        label: "Canary alert",
        kind: "external",
        health: "ok",
        sublabel: "checkout error rate",
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "On-call dashboard",
        kind: "service",
        health: decisionHealth,
        sublabel: `${values.panelCount} panels`,
        meta: { view: "flow" },
      },
      {
        id: "key-panel",
        label: "Error and canary panel",
        kind: "service",
        health: rankHealth,
        sublabel: `position ${values.keyPanelRank}`,
        meta: { view: "flow" },
      },
      {
        id: "runbook",
        label: "Runbook link",
        kind: "service",
        health: coverageHealth,
        sublabel: `${values.thresholdCoverage.toFixed(0)}% threshold coverage`,
        meta: { view: "flow" },
      },
      {
        id: "decision",
        label: "Rollback decision",
        kind: "service",
        health: decisionHealth,
        sublabel: `${values.timeToAnswer.toFixed(0)}s to answer`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("alert-dashboard", "alert", "dashboard", 1),
      edge("dashboard-key", "dashboard", "key-panel", 1, decisionHealth),
      edge("key-runbook", "key-panel", "runbook", values.thresholdCoverage / 100, coverageHealth),
      edge(
        "runbook-decision",
        "runbook",
        "decision",
        values.thresholdCoverage / 100,
        decisionHealth,
      ),
    ],
    metrics: [
      metric("time-to-answer", "Time to answer", values.timeToAnswer, " s", 60, 120, "number"),
      metric(
        "canary-error",
        "Canary error rate",
        values.canaryError,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric(
        "stable-error",
        "Stable error rate",
        values.stableError,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("panels", "Panels", values.panelCount, "", 16, 24, "count"),
      metric("key-panel-rank", "Key signal position", values.keyPanelRank, "", 6, 12, "count"),
      metric("threshold-gap", "Threshold gap", values.thresholdGap, "%", 25, 50, "percent"),
      metric(
        "annotation-density",
        "Annotation density",
        values.annotationDensity,
        " /h",
        3,
        6,
        "number",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      decisionHealth,
      annotationHealth,
    },
    summary: `Decision in ${values.timeToAnswer.toFixed(0)}s across ${values.panelCount} panels; canary ${values.canaryError.toFixed(1)}% vs stable ${values.stableError.toFixed(1)}%.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "time-to-answer",
    metricId: "time-to-answer",
    warn: 60,
    crit: 120,
    title: "The dashboard takes too long to answer the incident question",
    cause:
      "Too many panels, a buried key signal, missing thresholds, and annotation noise force the on-call engineer to scan instead of decide.",
    fix: "Put the error and canary comparison in the first row, add thresholds to the decision-critical panels, cut panels that do not change the decision, and link the next check.",
    checkFirst: [
      "Write the one question the dashboard must answer.",
      "Check the position of the panel that answers it.",
      "Check whether every decision-critical panel has a threshold and a next link.",
    ],
  },
  {
    id: "panels",
    metricId: "panels",
    warn: 16,
    crit: 24,
    title: "The dashboard has more panels than the decision can absorb",
    cause:
      "A data dump grows by accretion. Each panel adds scan time, but most do not change the rollback decision.",
    fix: "Move exploratory panels to a linked detail dashboard. Keep the first screen to the signals that change the decision.",
    checkFirst: [
      "Remove every panel that did not get read during the last incident.",
      "Move per-instance and historical detail behind a link.",
      "Check the first screen at 1440px and at 390px.",
    ],
  },
  {
    id: "threshold-gap",
    metricId: "threshold-gap",
    warn: 25,
    crit: 50,
    title: "Decision-critical panels lack thresholds or next-step links",
    cause:
      "A number without a good or bad state forces the reader to remember the SLO. A panel without a link forces a search.",
    fix: "Add absolute thresholds at the SLO boundaries and a link to the runbook, trace query, or rollback procedure.",
    checkFirst: [
      "Check the error, latency, saturation, and canary panels first.",
      "Check that the threshold matches the SLO, not a round number.",
      "Check that the link goes to the next check, not a generic home page.",
    ],
  },
  {
    id: "annotation-density",
    metricId: "annotation-density",
    warn: 3,
    crit: 6,
    title: "Annotations are crowding the signal",
    cause:
      "Every deploy, maintenance window, and alert annotation is drawn on the same panels. Past a few per hour, the lines hide the trend they were meant to explain.",
    fix: "Keep deploy and incident annotations, filter routine noise, and use tags so the reader can toggle a class of events.",
    checkFirst: [
      "Check which annotation classes are enabled by default.",
      "Check whether routine maintenance is annotated as an incident.",
      "Check whether the deploy marker aligns with the error change.",
    ],
  },
];

export const dashboardModel: SimModel = {
  id: "observability-grafana-dashboard",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const jitter = rng.between(-0.02, 0.02);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "stable-error" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.timeToAnswer >= 120 && frame.flags.decisionEvent !== 1) {
      pushEvent(next, {
        id: "decision-timeout",
        severity: "crit",
        title: "Decision timer exceeded",
        detail: `The canary is at ${values.canaryError.toFixed(1)}% errors against ${values.stableError.toFixed(1)}% on stable, but the key panel is at position ${values.keyPanelRank} of ${values.panelCount}. The on-call engineer has not reached a rollback decision.`,
        nodeId: "decision",
        metricId: "time-to-answer",
      });
      next.flags.decisionEvent = 1;
    }
    if (values.timeToAnswer < 120) next.flags.decisionEvent = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The decision takes ${values.timeToAnswer.toFixed(0)}s across ${values.panelCount} panels. The key signal is at position ${values.keyPanelRank}.`,
    );
    items.push(
      `Canary errors are ${values.canaryError.toFixed(1)}% against ${values.stableError.toFixed(1)}% on stable. That comparison is the decision; it belongs in the first row.`,
    );
    if (values.thresholdGap > 0) {
      items.push(
        `${values.thresholdGap.toFixed(0)}% of decision-critical panels lack a threshold or a next-step link.`,
      );
    } else {
      items.push("Every decision-critical panel has a threshold and a next-step link.");
    }
    if (values.annotationDensity > 3) {
      items.push(
        `${values.annotationDensity.toFixed(0)} annotations per hour are enough to hide the deploy that caused the change.`,
      );
    }
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
    description: "A focused dashboard: the canary regression is visible in the first row.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description:
      "A larger dashboard during a busy period; the decision is slower but still reachable.",
    tone: "warn",
    params: defaults({
      panelCount: 20,
      keyPanelRank: 8,
      thresholdCoverage: 60,
      annotationDensity: 4,
    }),
  },
  {
    id: "failure",
    label: "Data dump",
    description: "Forty panels bury the canary comparison; the decision timer exceeds two minutes.",
    tone: "crit",
    params: defaults({
      panelCount: 40,
      keyPanelRank: 18,
      thresholdCoverage: 20,
      annotationDensity: 8,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The dashboard is cut to ten panels and the canary comparison moves to the first row.",
    tone: "ok",
    params: defaults({
      panelCount: 10,
      keyPanelRank: 2,
      thresholdCoverage: 95,
      annotationDensity: 2,
    }),
  },
];

const experiment: Experiment = {
  id: "rollback-decision",
  title: "Make the rollback decision",
  simId: "grafana-dashboard",
  question:
    "The canary serves 2.4% errors against 0.2% on stable. The dashboard has 40 panels, the canary panel is at position 18, and the decision timer is past two minutes. What is the right first move?",
  prediction: {
    options: [
      { id: "rollback", label: "Roll back the canary, then investigate" },
      { id: "scale", label: "Scale out the canary and watch" },
      { id: "restart", label: "Restart the canary pods" },
      { id: "wait", label: "Wait for the dashboard to update" },
    ],
    correctOptionId: "rollback",
    explanation:
      "The error is isolated to the canary and is an order of magnitude above stable. Rolling back removes the user impact while preserving evidence. Scaling or restarting keeps the bad version serving traffic; waiting spends more error budget.",
  },
  setup: presets[2].params,
  runFor: 60,
  observe: [
    "Time to answer reaches 197s, past the critical threshold.",
    "The key canary panel sits at position 18 of 40.",
    "Only 20% of decision-critical panels have thresholds or next-step links.",
    "The decision timer event fires while the canary keeps serving 2.4% errors.",
  ],
  explain:
    "A dashboard is a decision aid. The data already contains the answer: canary errors are isolated and much higher than stable. A data dump delays the decision by making the reader scan. The correct incident response is to roll back first, then use the dashboard to find the cause.",
  fix: presets[3].params,
  debrief:
    "The redesigned dashboard puts the canary comparison near the top, cuts forty panels to ten, adds thresholds, and links the runbook. Time to answer falls to about 32s. The rollback itself is unchanged; the dashboard now supports it instead of delaying it.",
};

const designExperiment: Experiment = {
  id: "dashboard-change",
  title: "Which dashboard change buys the most decision time?",
  simId: "grafana-dashboard",
  question:
    "The dashboard has 40 panels, the canary comparison at position 18, 20% threshold coverage, and 8 annotations per hour. Which single change reduces modeled time-to-answer the most?",
  prediction: {
    options: [
      { id: "move-key", label: "Move the canary comparison to position 1" },
      { id: "cut-panels", label: "Cut the dashboard to 10 panels" },
      { id: "coverage", label: "Raise threshold coverage to 100%" },
      { id: "annotations", label: "Remove all annotations" },
    ],
    correctOptionId: "move-key",
    explanation:
      "Order is the largest single lever in this model. Moving the key signal from position 18 to position 1 removes 17 positions of scanning, more than cutting 30 panels or removing the threshold gap or annotation noise.",
  },
  setup: presets[2].params,
  runFor: 60,
  observe: [
    "Moving the canary comparison first lowers time to answer from 197s to 112s.",
    "Cutting to 10 panels lowers it to 127s because the key signal lands at position 10.",
    "Raising threshold coverage to 100% lowers it to 161s.",
    "Removing all annotations lowers it to 169s.",
  ],
  explain:
    "The first screen is read in order. A key signal below the fold costs scanning time on every incident, while a threshold gap and annotation noise add smaller delays. The largest single win is putting the decision-critical comparison first; the other changes are still necessary to reach a fast, legible dashboard.",
  fix: { keyPanelRank: 1, panelCount: 10, thresholdCoverage: 100, annotationDensity: 0 },
  debrief:
    "Moving the key signal first is the biggest single change, but it only takes the modeled decision to 112s. The full redesign puts the signal first, cuts to ten panels, closes the threshold gap, and removes annotation noise, reaching about 18s. The lesson is to order by the decision, then remove everything that does not support it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A dashboard is a decision aid. It should answer one question for one reader at one moment, usually the on-call engineer during an incident. The question might be whether to roll back, whether to scale, or which dependency is failing. Panels that do not change that answer are exploration, and exploration belongs somewhere else.",
  },
  {
    type: "p",
    text: "The design follows from the question. Put the signal that answers it in the first row, add thresholds at the service-level objective (SLO) boundaries, annotate deploys and incidents, and link the next check. Cut everything that adds scan time without changing the decision.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The on-call path is alert, dashboard, next check, decision. The alert says something is wrong. The dashboard tells the reader whether the problem is real, where it started, and which action is safe. The next check is a trace query, a log query, a runbook, or a rollback link. A dashboard that stops before the next check leaves the reader to search.",
  },
  {
    type: "table",
    headers: ["Decision aid", "Data dump"],
    rows: [
      ["One question in the title", "A service name and every metric"],
      ["Key signal in the first row", "Key signal buried at position 18"],
      ["Thresholds at the SLO", "Green lines with no good or bad state"],
      ["Deploy and incident annotations", "Every routine event on every panel"],
      ["Link to the next check", "No link, or a generic home page"],
    ],
  },
  {
    type: "p",
    text: "Grafana's own guidance says a dashboard should tell a story or answer a question, and that cognitive load is the enemy. The layout should follow the decision order, not the data source order. A service hierarchy can help, but only if the reader can still find the one panel that changes the action.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Data dump. Watch the time-to-answer metric and the decision node. Run the guided experiment before reading the debrief. Then apply Recovery and compare the panel count, key position, threshold gap, and annotation density.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to answer: the modeled seconds until the on-call engineer can make the rollback decision.",
      "Canary and stable error rates: the comparison that should drive the decision.",
      "Panel count: how much surface the reader has to scan.",
      "Key signal position: where the canary comparison appears in reading order.",
      "Threshold gap: the share of decision-critical panels without a threshold or next-step link.",
      "Annotation density: how much context is competing with the signal.",
    ],
  },
  {
    type: "p",
    text: "The model is deliberately simple: the timer is a teaching function of panel count, key position, threshold coverage, and annotation density. Real dashboard reading time depends on the reader, the incident, and the tool. The shape is the lesson: every panel and every missing threshold adds time before the decision.",
  },
  { type: "sim", simId: "grafana-dashboard" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The canary was failing at 2.4% against 0.2% on stable, but the dashboard buried the comparison at position 18 of 40 panels. Only a fifth of the decision-critical panels had thresholds or next-step links, and eight annotations per hour competed with the signal. The reader had the data but not the answer, so the decision timer passed two minutes.",
  },
  {
    type: "p",
    text: "The redesigned dashboard cut the panel count to ten, moved the canary comparison near the top, added thresholds, and linked the runbook. Time to answer fell to about 32 seconds. The incident data did not change; the path from data to decision did.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "An on-call engineer scrolling past host CPU and disk panels to find the service error rate.",
      "A canary panel with no stable comparison, so the reader cannot tell whether the error is new.",
      "A dashboard row ordered by data source or team ownership instead of decision order.",
      "Dozens of annotation lines, including routine maintenance, crossing the error graph.",
      "A runbook link that goes to a home page rather than the rollback procedure.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Write the one question the dashboard must answer. Find the panel that answers it and check its position. Check whether the panel has a threshold and a link to the next check. Count the panels that did not change the last incident decision.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the decision question at the top of the dashboard.",
      "Put the signal that answers it in the first row, with the comparison that makes it interpretable.",
      "Add thresholds at the SLO boundaries and a visible state label.",
      "Annotate deploys and incidents; filter routine noise.",
      "Link the next check: trace query, log query, runbook, or rollback.",
      "Cut panels that do not change the decision and move them to a detail dashboard.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A focused dashboard is faster to read but may omit a signal needed for an unusual incident; link the detail instead of adding it to the first screen.",
      "Thresholds improve legibility but must match the SLO, or they teach the wrong boundary.",
      "Annotations explain changes but become noise at high density; filter and tag them.",
      "A separate detail dashboard keeps the main view clean but adds a navigation step during an incident.",
      "Fewer panels reduce scan time but can hide a dependency; pair the main view with a service map or trace link.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "one-question",
    question:
      "Design the first screen of an on-call dashboard for a checkout service. What question does it answer, and what is on it?",
    difficulty: 1,
    hints: [
      "Start with the decision, not the metrics.",
      "The comparison is often more useful than the absolute value.",
    ],
    answer:
      "The question is whether the checkout service is failing for users and whether the current version is responsible. The first row has the error ratio split by stable and canary, success-path p99, traffic, and saturation of the most constrained resource. Each panel has an SLO threshold and a link to traces or the runbook. The deploy and incident annotations are visible. Host CPU mosaics and business metrics live on a linked detail dashboard.",
    followUps: [
      "Where would you put the dependency latency panel?",
      "What would you remove first if the screen were too dense?",
      "How do you support a mobile reader?",
    ],
    redFlags: [
      "Starts with every metric available.",
      "No stable-versus-canary comparison.",
      "No link to the next check.",
    ],
    rubric: [
      "Names a decision question.",
      "Orders signals by decision value.",
      "Includes thresholds and links.",
      "States what is left out.",
    ],
  },
  {
    id: "data-dump",
    question:
      "A dashboard has forty panels and no one uses it during incidents. How do you diagnose and fix it?",
    difficulty: 2,
    hints: ["Watch an on-call engineer use it.", "Remove panels that did not change a decision."],
    answer:
      "I would observe a recent incident replay or ask the on-call engineer to narrate the last use. I would find where they scrolled, what they ignored, and where they left the dashboard for another tool. Then I would write the decision question, move the answering signal to the first row, add thresholds and next-step links, and cut or link the rest. I would measure time to answer before and after, not panel count alone.",
    followUps: [
      "How would you decide which panels to keep?",
      "What if a stakeholder owns a panel?",
      "How do you prevent the dashboard from growing again?",
    ],
    redFlags: [
      "Deletes panels without observing use.",
      "Adds more panels to explain the old ones.",
      "Optimizes for visual appeal only.",
    ],
    rubric: [
      "Observes real use.",
      "Names the decision question.",
      "Cuts or links non-decision panels.",
      "Measures time to answer.",
    ],
  },
  {
    id: "annotations",
    question: "How do annotations help an incident, and when do they make a dashboard worse?",
    difficulty: 2,
    hints: [
      "A deploy marker can explain a change.",
      "Every annotation is drawn on every supporting panel.",
    ],
    answer:
      "Annotations mark deploys, incidents, and maintenance so the reader can connect a change in the graph to a change in the system. They help when they are sparse, tagged, and aligned with the decision. They hurt when every routine event is drawn on every panel: the lines compete with the signal, the reader cannot tell which event matters, and the graph becomes harder to read. I keep deploy and incident annotations, filter routine noise, and let the reader toggle classes.",
    followUps: [
      "Which annotations would you enable by default?",
      "How would you annotate a canary rollback?",
      "What is the cost of annotation queries?",
    ],
    redFlags: [
      "Enables every annotation by default.",
      "Uses annotations as a substitute for thresholds.",
      "Ignores the deploy marker during a regression.",
    ],
    rubric: [
      "Names the causal use.",
      "Explains the noise failure.",
      "Filters and tags.",
      "Connects to the decision.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The dashboard title states the question it answers.",
      "The decision-critical signal is in the first row.",
      "Every critical panel has a threshold at the SLO and a next-step link.",
      "Deploy and incident annotations are enabled; routine noise is filtered.",
      "The first screen works at 1440px and at 390px.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "State the decision the dashboard must support.",
      "Find the panel that answers it before scanning the rest.",
      "Check the stable-versus-canary comparison.",
      "Follow the link to traces or the runbook.",
      "Record the time from opening the dashboard to the decision.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove or link panels that were not read.",
      "Add the missing threshold or next-step link.",
      "Check that the annotations explained the change.",
      "Replay the incident and measure the new time to answer.",
    ],
  },
];

const references = [
  {
    title: "Grafana dashboard best practices",
    url: "https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Answer a question, reduce cognitive load, order by the decision, and link the next check.",
  },
  {
    title: "Configure thresholds",
    url: "https://grafana.com/docs/grafana/latest/panels-visualizations/configure-thresholds/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Absolute and percentage thresholds, threshold lines, and color states.",
  },
  {
    title: "Annotate visualizations",
    url: "https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/annotate-visualizations/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Deploy and incident annotations, annotation queries, and filtering.",
  },
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Detection time, precision, recall, and the action an alert should support.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "grafana-dashboard": {
      model: dashboardModel,
      presets,
      instructions:
        "Start healthy, apply Data dump, and watch the decision timer. Then apply Recovery and compare the panel count, key position, threshold gap, and annotation density.",
      experimentIds: [experiment.id, designExperiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The canary regression is the fixed incident in every preset; the presets change the dashboard, not the service. Panel count, reading time, and annotation density are teaching figures, not Grafana limits.",
    },
  },
  experiments: [experiment, designExperiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-golden-signals",
    "observability-metrics-types",
    "observability-histogram-quantile",
  ],
};
