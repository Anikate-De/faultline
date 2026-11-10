import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "fingerprintSpecificity",
    label: "Fingerprint specificity",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Grouping",
    help: "How much of the stack, route, and exception chain the fingerprint includes. Higher specificity separates more distinct causes in this model.",
    format: "percent" as const,
  },
  {
    id: "distinctCauses",
    label: "Distinct root causes",
    min: 1,
    max: 10,
    step: 1,
    value: 3,
    unit: " causes",
    group: "Traffic",
    help: "Independent failure causes arriving in the same window. A good fingerprint gives each cause its own issue.",
    format: "count" as const,
  },
  {
    id: "noiseShare",
    label: "Noise event share",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Traffic",
    help: "Events from handled timeouts, retries, or client disconnects that share a generic message with real failures.",
    format: "percent" as const,
  },
  {
    id: "eventVolume",
    label: "Event volume",
    min: 100,
    max: 200_000,
    step: 100,
    value: 4_000,
    unit: " /h",
    group: "Traffic",
    help: "Error events per hour. It changes ingest load in this model, not grouping quality or triage time.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  specificity: number;
  causes: number;
  noise: number;
  volume: number;
  groups: number;
  buried: number;
  shortfall: number;
  largestShare: number;
  triageMinutes: number;
}

function compute(p: Params): Computed {
  const specificity = num(p, "fingerprintSpecificity", 90);
  const causes = Math.round(num(p, "distinctCauses", 3));
  const noise = num(p, "noiseShare", 10);
  const volume = Math.round(num(p, "eventVolume", 4_000));
  const groups = clamp(Math.round(causes * (specificity / 100)), 1, causes);
  const buried = causes - groups;
  const shortfall = (buried / causes) * 100;
  const largestShare = clamp((100 - noise) / groups + noise, 0, 100);
  const triageMinutes = 8 + buried * 12 + noise * 0.15;
  return { specificity, causes, noise, volume, groups, buried, shortfall, largestShare, triageMinutes };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const groupingHealth = healthFor(values.shortfall, 15, 40);
  const storeHealth = values.buried > 0 ? healthFor(values.largestShare, 60, 85) : "ok";
  const triageHealth = healthFor(values.triageMinutes, 20, 30);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: "ok",
        utilization: 0.2,
        sublabel: `${values.volume.toLocaleString()} events/h`,
      },
      {
        id: "sdk",
        label: "Error SDK",
        kind: "worker",
        health: "ok",
        utilization: clamp(values.volume / 200_000),
        sublabel: "capture and scrub",
      },
      {
        id: "ingest",
        label: "Ingest",
        kind: "service",
        health: "ok",
        utilization: clamp(values.volume / 100_000),
        sublabel: "dedupe and rate limit",
      },
      {
        id: "fingerprint",
        label: "Fingerprint",
        kind: "worker",
        health: groupingHealth,
        utilization: values.shortfall / 100,
        sublabel: `${values.groups} of ${values.causes} causes split`,
      },
      {
        id: "issues",
        label: "Issue store",
        kind: "storage",
        health: storeHealth,
        utilization: values.largestShare / 100,
        sublabel: `largest group ${values.largestShare.toFixed(0)}%`,
      },
      {
        id: "oncall",
        label: "On-call triage",
        kind: "worker",
        health: triageHealth,
        utilization: clamp(values.triageMinutes / 60),
        sublabel: `${values.triageMinutes.toFixed(0)} min to first cause`,
      },
    ],
    edges: [
      edge("app-sdk", "app", "sdk", clamp(values.volume / 200_000), "ok"),
      edge("sdk-ingest", "sdk", "ingest", clamp(values.volume / 200_000), "ok"),
      edge("ingest-fingerprint", "ingest", "fingerprint", clamp(values.volume / 200_000), groupingHealth),
      edge("fingerprint-issues", "fingerprint", "issues", clamp(values.volume / 200_000), storeHealth),
      edge("issues-oncall", "issues", "oncall", clamp(values.largestShare / 100), triageHealth),
    ],
    metrics: [
      metric("visibility-shortfall", "Causes without their own issue", values.shortfall, "%", 15, 40, "percent"),
      metric("largest-group-share", "Largest group share", values.largestShare, "%", undefined, undefined, "percent"),
      metric(
        "group-concentration",
        "Group concentration",
        values.buried > 0 ? values.largestShare : 0,
        "%",
        60,
        85,
        "percent",
      ),
      metric("triage-time", "Time to first cause", values.triageMinutes, " min", 20, 30, "number"),
      metric("group-count", "Issue groups", values.groups, " groups", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.buried} of ${values.causes} causes share an issue; the largest group holds ${values.largestShare.toFixed(0)}% of events; first-cause triage takes ${values.triageMinutes.toFixed(0)} minutes.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "visibility-shortfall",
    metricId: "visibility-shortfall",
    warn: 15,
    crit: 40,
    title: "A failure cause has no issue of its own",
    cause: "The fingerprint is too generic. Distinct stack frames, exception types, or routes collapse into one issue, so a new cause inherits the history of an old one.",
    fix: "Add stable, cause-specific inputs to the fingerprint: exception type, the top application stack frame, and the route or operation. Keep volatile values out.",
    checkFirst: [
      "Open the largest issue and group events by exception type, route, and release.",
      "Find the newest cause and check when its events first appeared.",
      "Compare the stack frames of the merged causes.",
    ],
  },
  {
    id: "group-concentration",
    metricId: "group-concentration",
    warn: 60,
    crit: 85,
    title: "One issue owns almost every event",
    cause: "A generic message such as `request failed` or `timeout` is being used as the fingerprint, so unrelated failures and handled noise land in the same group.",
    fix: "Fingerprint on the exception class and the deepest stable application frame, not the message alone. Filter handled noise before it becomes an event.",
    checkFirst: [
      "Check the fingerprint inputs for the issue.",
      "Count handled timeouts and retries in the group.",
      "Look for a release that changed the thrown exception or message.",
    ],
  },
  {
    id: "triage-time",
    metricId: "triage-time",
    warn: 20,
    crit: 30,
    title: "First-cause triage is too slow",
    cause: "Responders must read every event in a merged group to find the distinct failure. Group count and noise both add work.",
    fix: "Split the causes, suppress handled noise, and sort issues by first-seen time and release. Add the cause to the alert payload.",
    checkFirst: [
      "Measure how many events a responder reads before the first useful clue.",
      "Check whether the issue includes multiple releases or routes.",
      "Look for duplicate issues created by an unstable fingerprint.",
    ],
  },
];

export const errorGroupingModel: SimModel = {
  id: "observability-error-grouping",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "triage-time" ? { ...item, value: item.value * jitter } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.shortfall >= 40 && frame.flags.buriedSeen !== 1) {
      pushEvent(next, {
        id: "error-class-buried",
        at: frame.t,
        severity: "crit",
        title: "A distinct error class is buried in an existing issue",
        detail: `${values.buried} of ${values.causes} causes share one group. The largest issue holds ${values.largestShare.toFixed(0)}% of events, and triage takes about ${values.triageMinutes.toFixed(0)} minutes.`,
        nodeId: "fingerprint",
        metricId: "visibility-shortfall",
      });
      next.flags.buriedSeen = 1;
    }
    if (values.shortfall < 40) next.flags.buriedSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.buried} of ${values.causes} causes share an issue; the largest group holds ${values.largestShare.toFixed(0)}% of events; first-cause triage takes ${values.triageMinutes.toFixed(0)} minutes.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.buried > 0) {
      items.push(`${values.buried} of ${values.causes} causes never get their own issue. A responder sees one history and cannot tell which cause is new.`);
    } else {
      items.push(`Each of the ${values.causes} causes has its own issue, so first-seen and release comparisons are meaningful.`);
    }
    items.push(`The largest group holds ${values.largestShare.toFixed(0)}% of events. That number mixes real failures with ${values.noise.toFixed(0)}% handled noise.`);
    items.push(`At ${values.volume.toLocaleString()} events per hour, event count is a weak triage signal; a cause with three events can be the outage.`);
    items.push(`Triage takes about ${values.triageMinutes.toFixed(0)} minutes. Group count and noise both add reading time before the first clue.`);
    return items;
  },
  legend: [
    { label: "Separated", tone: "ok" },
    { label: "Merged", tone: "warn" },
    { label: "Buried", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three root causes get three issues; 10% handled noise stays visible but bounded.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy hour",
    description: "Four causes and more noise. One cause merges into another issue, and triage slows.",
    tone: "warn",
    params: defaults({ fingerprintSpecificity: 75, distinctCauses: 4, noiseShare: 15, eventVolume: 12_000 }),
  },
  {
    id: "failure",
    label: "Generic message",
    description: "The fingerprint uses only the error message. Four causes and handled timeouts collapse into one issue.",
    tone: "crit",
    params: defaults({ fingerprintSpecificity: 20, distinctCauses: 4, noiseShare: 30, eventVolume: 40_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Exception type, top application frame, and route split the causes; handled noise is filtered out.",
    tone: "ok",
    params: defaults({ fingerprintSpecificity: 95, distinctCauses: 4, noiseShare: 5, eventVolume: 4_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-error-split",
  title: "Predict what the generic fingerprint hides",
  simId: "error-grouping",
  question:
    "One issue has 40,000 events and three unrelated root causes. The fingerprint uses only the error message. What happens when a fourth cause arrives?",
  prediction: {
    options: [
      { id: "own-issue", label: "It gets its own issue because the stack trace is different" },
      { id: "buried", label: "It joins the existing issue, and its first-seen time is lost in the shared history" },
      { id: "dropped", label: "The SDK drops it because the issue already exists" },
      { id: "alert", label: "It pages immediately because the event count is higher" },
    ],
    correctOptionId: "buried",
    explanation:
      "The issue identity is the fingerprint. If the message is generic and the fingerprint ignores the exception type and stable stack frame, a new cause produces the same fingerprint as the old ones. The event is stored, but it is indistinguishable from the existing group, so first-seen, release, and cause are lost.",
  },
  setup: defaults({ fingerprintSpecificity: 20, distinctCauses: 4, noiseShare: 30, eventVolume: 40_000 }),
  runFor: 20,
  observe: [
    "All four causes collapse into one group; the visibility shortfall is 75%.",
    "The largest group holds 100% of events, including 30% handled noise.",
    "First-cause triage takes about 49 minutes.",
    "The fingerprint and issue-store nodes fail while ingestion stays healthy.",
  ],
  explain:
    "Grouping is an identity decision. A fingerprint should be stable across deploys and specific enough that different causes produce different values. Exception type, the top application frame, and the route are stable inputs. The raw message is not: it often contains variable data, and a generic message ignores the cause entirely. The goal is not one issue per event; it is one issue per actionable cause.",
  fix: defaults({ fingerprintSpecificity: 95, distinctCauses: 4, noiseShare: 5, eventVolume: 40_000 }),
  debrief:
    "With a specific fingerprint the four causes split into four issues and triage drops to about nine minutes. Noise filtering removes handled timeouts, so the largest group is smaller and the first-seen time is meaningful. The tradeoff is that every fingerprint input becomes a compatibility surface: changing it resets issue history, and over-splitting turns one cause into many low-volume issues.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Error tracking turns a stream of exception events into a smaller set of issues. Each event carries a stack trace, an exception type, a message, a route, a release, and tags. The tracker computes a fingerprint from selected inputs and assigns the event to the issue with the same fingerprint. Everything responders use later, including first-seen time, event count, release correlation, and ownership, depends on that identity.",
  },
  {
    type: "p",
    text: "A fingerprint is a tradeoff between stability and specificity. Too generic, and unrelated causes collapse into one issue with a misleading history. Too specific, and every user ID, timestamp, or request path creates a new issue, so a single cause looks like hundreds. A good fingerprint uses inputs that are stable across deploys and specific to the cause: the exception class, the top application stack frame, the operation or route, and sometimes the error code.",
  },
  {
    type: "p",
    text: "Noise is part of grouping, not a separate problem. Handled timeouts, retries, client disconnects, and bot traffic can share a generic message with real failures. If they reach the tracker, they inflate the largest group and make event count useless as a severity signal. Filtering or dropping handled noise before it becomes an event is cheaper than trying to separate it later.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application, error SDK, ingest, fingerprint, issue store, then triage and alerting. The SDK decides what is captured and what is scrubbed. Ingest decides what is rate-limited or dropped. The fingerprint decides identity. The issue store keeps the history, and the alert rule decides whether anyone is told.",
  },
  {
    type: "table",
    headers: ["Fingerprint input", "Stability", "Specificity", "Risk"],
    rows: [
      ["Exception class", "High", "Medium", "Different causes with the same class merge"],
      ["Top application frame", "High if code is stable", "High", "Refactors change the fingerprint"],
      ["Route or operation", "Medium", "Medium", "Dynamic paths create unique issues"],
      ["Raw message", "Low", "Low to medium", "Variable data splits or generic text merges"],
      ["Release or user ID", "Low for identity", "Very high", "Every release or user becomes a new issue"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: four causes, a specificity curve, and a triage-time formula. They are teaching values, not a vendor guarantee. The structural lesson is that the fingerprint chooses which failures share a history.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Causes without their own issue: the share of distinct failures hidden inside a shared group.",
      "Largest group share: how much of the stream one issue absorbs, including noise.",
      "Time to first cause: the reading time before a responder finds the new failure.",
      "Issue count: context for whether the fingerprint is splitting too much or too little.",
      "Node health from capture through fingerprinting to triage.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Generic message. Watch the largest group absorb every cause while the ingest node stays healthy. Run the experiment before the debrief, then raise fingerprint specificity and lower noise to see the split.",
  },
  {
    type: "compare",
    leftTitle: "Generic fingerprint",
    rightTitle: "Cause-specific fingerprint",
    rows: [
      { label: "Issue count", left: "One issue, many causes", right: "One issue per actionable cause" },
      { label: "First seen", left: "Inherited from the oldest cause", right: "Tracks the new cause" },
      { label: "Release correlation", left: "Blended across releases", right: "Comparable by release" },
      { label: "Noise", left: "Inflates the largest group", right: "Filtered or separated" },
      { label: "Failure mode", left: "Buried new class", right: "Issue explosion if inputs are unstable" },
    ],
  },
  { type: "sim", simId: "error-grouping" },
  { type: "experiment", experimentId: "predict-error-split" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The generic message became the identity. Four causes produced the same fingerprint, so the tracker stored every event in one issue. The event count grew, but the count described the group, not any one cause. A new failure inherited the old issue's first-seen time, and the responder had to read events to discover that more than one cause existed.",
  },
  {
    type: "p",
    text: "Raising specificity split the causes and filtering handled noise reduced the largest group. Triage time fell because the first clue was on the issue list rather than inside a merged timeline. The recovery is not free: the fingerprint changed, so issue history resets, and the new inputs must remain stable across refactors.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Sentry: one issue with a long event list, multiple exception types, and a first-seen time older than the suspected release.",
      "Sentry or Datadog: fingerprint rules or grouping configuration that use the message or a dynamic value.",
      "Issue tags: route, release, and environment distributions that show several clusters inside one issue.",
      "Alert payloads: a generic title with no cause, which forces the responder to open the issue before deciding.",
      "Event volume: a large group that grows after every deploy, including handled timeouts and retries.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Open the largest issue and group its events by exception type, top stack frame, route, and release. If those clusters exist inside one issue, the fingerprint is too generic. Split on the stable inputs before you change alert thresholds.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the distinct causes inside the group using exception type, stack frame, route, and release.",
      "Choose stable fingerprint inputs that separate those causes and exclude user IDs, timestamps, and raw messages.",
      "Filter handled noise before capture or mark it with a distinct fingerprint.",
      "Change the fingerprint in a controlled release and accept that history will reset for the split issues.",
      "Update alert routing so the payload names the cause and links to the issue.",
      "Watch issue count after the change; a sudden explosion means the new inputs are too specific.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Specific fingerprints separate causes and reset history when they change; plan the migration and keep the old issue linked.",
      "Too many inputs create issue sprawl, which raises triage cost and hides high-volume causes in a long list.",
      "Filtering noise reduces volume and can hide a real failure that shares the same handled path; test the filter against known incidents.",
      "Stack traces and messages can contain personal data; scrub at capture and avoid putting raw payloads in fingerprints.",
      "Grouping is not detection: a correctly grouped issue still needs an alert rule and an owner.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "split-group",
    question:
      "One error group has 40,000 events and three unrelated root causes. How do you split it without creating hundreds of issues?",
    difficulty: 3,
    hints: [
      "Start from the stable, cause-specific inputs.",
      "Separate identity from display text.",
    ],
    answer:
      "I would inspect the events by exception type, top application stack frame, route, and release to identify the three causes. Then I would build a fingerprint from the smallest stable set that separates them, usually exception class plus the top application frame plus the operation. I would exclude message text, user IDs, request IDs, and timestamps. I would change it in one release, link the old issue, and watch the issue count for a week. If a cause still merges, I add one specific input; if issues explode, I remove a volatile one.",
    followUps: [
      "What would you do with the old issue's history?",
      "How would you detect over-splitting?",
      "Which input would you avoid using first?",
    ],
    redFlags: [
      "Uses the raw message as the fingerprint.",
      "Adds user ID or request ID.",
      "Splits without a migration plan.",
    ],
    rubric: [
      "Finds causes before changing the fingerprint.",
      "Uses stable, cause-specific inputs.",
      "Plans migration and measures issue count.",
    ],
  },
  {
    id: "fingerprint-stability",
    question:
      "Why is the raw error message a poor fingerprint input?",
    difficulty: 2,
    hints: [
      "Think about variable data and generic messages.",
      "A fingerprint should identify a cause, not a string.",
    ],
    answer:
      "The raw message often contains variable data such as an order ID, a URL, or a timestamp, so every event gets a different fingerprint and the issue explodes. If the message is generic, the opposite happens: unrelated causes collapse into one issue. The message is useful for display and search, but identity should come from stable structure such as the exception class and the top application frame. A normalized message can be a secondary input if it is bounded and stable.",
    followUps: [
      "When would a normalized message be acceptable?",
      "How do stack frame paths change across deploys?",
      "What would you do with a third-party exception you cannot change?",
    ],
    redFlags: [
      "Uses the full message including IDs.",
      "Ignores the explosion or collapse risk.",
      "Has no normalization step.",
    ],
    rubric: [
      "Names variable-data and generic-message failure modes.",
      "Prefers structural inputs.",
      "Mentions normalization.",
    ],
  },
  {
    id: "noise",
    question:
      "Handled timeouts are 30% of an error group's events. What do you change, and what is the risk?",
    difficulty: 2,
    hints: [
      "Noise can be filtered before capture or separated by fingerprint.",
      "Do not hide a real failure that shares the path.",
    ],
    answer:
      "I would first confirm the events are truly handled and not a real dependency failure. Then I would stop capturing them as errors, or capture them at a lower level with a distinct fingerprint and a bounded sample. Filtering before capture is cheaper and keeps the error group meaningful. The risk is that the same path can fail for real, so I would keep a counter or a low-volume issue for the handled case and alert on the ratio, not on each event.",
    followUps: [
      "How would you distinguish a handled timeout from a real one?",
      "Would you drop the event or sample it?",
      "What metric would you keep for the filtered path?",
    ],
    redFlags: [
      "Drops all timeouts without checking.",
      "Leaves noise in the main issue.",
      "Has no residual signal.",
    ],
    rubric: [
      "Verifies the events are handled.",
      "Filters or separates noise at capture.",
      "Keeps a residual signal and a real-failure check.",
    ],
  },
  {
    id: "triage-order",
    question:
      "At 3 a.m., how do you order error issues for triage when the largest group is mostly noise?",
    difficulty: 2,
    hints: [
      "Event count is not impact.",
      "Use first-seen, release, and user-facing symptoms.",
    ],
    answer:
      "I would not sort by raw event count. I would sort by first-seen time for a new cause, by release correlation for a change-induced failure, and by user impact from the service's SLO or symptom metrics. I would separate handled noise into its own view and check whether the largest group is growing because of one cause or many. The first question is which issue explains user pain, not which issue has the most events.",
    followUps: [
      "How would you detect a low-volume, high-impact issue?",
      "What role should release markers play?",
      "How would you present noise without hiding it?",
    ],
    redFlags: [
      "Sorts only by event count.",
      "Ignores user impact.",
      "Lets noise dominate the first screen.",
    ],
    rubric: [
      "Uses impact and first-seen.",
      "Separates noise.",
      "Connects error groups to symptoms.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The fingerprint uses exception type, a stable application frame, and the operation.",
      "Dynamic values such as user ID, request ID, timestamp, and raw URL are excluded.",
      "Handled noise is filtered or given a separate, low-volume issue.",
      "Every issue has an owner, a severity rule, and a link to the runbook.",
      "A fingerprint change has a migration note because it resets issue history.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Group the largest issue by exception type, route, release, and top frame.",
      "Find the newest cause before changing the fingerprint.",
      "Check whether the alert payload names the cause.",
      "Compare with user-facing symptoms; event count alone is not impact.",
      "Record the split and the old issue link for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the new causes have their own issues and realistic first-seen times.",
      "Watch issue count for a week to catch over-splitting.",
      "Add a regression case for the fingerprint inputs.",
      "Review scrubbing for personal data in stack traces and messages.",
    ],
  },
];

const references = [
  {
    title: "Event Grouping",
    url: "https://docs.sentry.io/concepts/data-management/event-grouping/",
    publisher: "Sentry",
    kind: "docs" as const,
    note: "How fingerprints define issue identity and how grouping behaves.",
  },
  {
    title: "Fingerprint Rules",
    url: "https://docs.sentry.io/concepts/data-management/event-grouping/fingerprint-rules/",
    publisher: "Sentry",
    kind: "docs" as const,
    note: "Custom fingerprint inputs and the stability tradeoff.",
  },
  {
    title: "Error Tracking",
    url: "https://docs.datadoghq.com/error_tracking/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Issue grouping, triage, and error tracking signals.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "error-grouping": {
      model: errorGroupingModel,
      presets,
      instructions:
        "Start Healthy, then apply Generic message. Watch the largest group absorb every cause, then run the experiment and raise specificity. Keep an eye on issue count for over-splitting.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Specificity, triage time, and event volume are teaching values, not a vendor guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-structured-logging",
    "observability-pii-redaction",
    "observability-symptom-alerting",
    "observability-alert-fatigue",
  ],
};
