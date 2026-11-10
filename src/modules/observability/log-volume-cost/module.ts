import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BYTES_PER_LINE = 350;
const SECONDS_PER_DAY = 86_400;
// Illustrative blended rates for teaching, not vendor prices.
const INGEST_RATE_PER_GB = 0.1;
const STORAGE_RATE_PER_GB_DAY = 0.015;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 10,
    max: 5_000,
    step: 10,
    value: 400,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second reaching the service. Each request emits its own log lines.",
    format: "rps" as const,
  },
  {
    id: "linesPerRequest",
    label: "Lines per request",
    min: 1,
    max: 200,
    step: 1,
    value: 12,
    unit: " lines",
    group: "Volume",
    help: "Log lines emitted for one request across all services. This is the multiplier that verbose releases change.",
    format: "count" as const,
  },
  {
    id: "debugShare",
    label: "Debug share of lines",
    min: 0,
    max: 100,
    step: 5,
    value: 5,
    unit: "%",
    group: "Level",
    help: "Share of lines emitted at DEBUG. They are usually the first candidates for sampling or removal.",
    format: "percent" as const,
  },
  {
    id: "debugSampling",
    label: "Debug lines kept",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Level",
    help: "Share of DEBUG lines that survive sampling. Error and audit lines are not sampled by this control.",
    format: "percent" as const,
  },
  {
    id: "retentionDays",
    label: "Retention",
    min: 1,
    max: 90,
    step: 1,
    value: 15,
    unit: " days",
    group: "Copies",
    help: "Days the index keeps the retained copy. Storage cost scales with volume times retention.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rps: number;
  lines: number;
  debugShare: number;
  sampling: number;
  retention: number;
  effectiveLines: number;
  ingestGb: number;
  spend: number;
  retainedTb: number;
  ingestPerRequestKb: number;
  costPerRequestMicro: number;
}

function compute(p: Params): Computed {
  const rps = Math.round(num(p, "requestRate", 400));
  const lines = num(p, "linesPerRequest", 12);
  const debugShare = num(p, "debugShare", 5);
  const sampling = num(p, "debugSampling", 100);
  const retention = Math.round(num(p, "retentionDays", 15));
  const effectiveLines = lines * (1 - (debugShare / 100) * (1 - sampling / 100));
  const ingestGb = (rps * effectiveLines * SECONDS_PER_DAY * BYTES_PER_LINE) / 1_000_000_000;
  const spend = ingestGb * INGEST_RATE_PER_GB + ingestGb * retention * STORAGE_RATE_PER_GB_DAY;
  const retainedTb = (ingestGb * retention) / 1_000;
  return {
    rps,
    lines,
    debugShare,
    sampling,
    retention,
    effectiveLines,
    ingestGb,
    spend,
    retainedTb,
    ingestPerRequestKb: (effectiveLines * BYTES_PER_LINE) / 1_024,
    costPerRequestMicro: (spend / (rps * SECONDS_PER_DAY)) * 1_000_000,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const agentHealth = healthFor(values.ingestGb, 800, 1_200);
  const pipelineHealth = healthFor(values.spend, 300, 600);
  const storeHealth = healthFor(values.retainedTb, 10, 25);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: "ok",
        utilization: clamp(values.ingestPerRequestKb / 20),
        sublabel: `serving · ${values.effectiveLines.toFixed(1)} lines/request`,
      },
      {
        id: "agent",
        label: "Log agent",
        kind: "worker",
        health: agentHealth,
        utilization: clamp(values.ingestGb / 1_500),
        sublabel: `${values.ingestGb.toFixed(0)} GB/day`,
      },
      {
        id: "pipeline",
        label: "Ingest pipeline",
        kind: "service",
        health: pipelineHealth,
        utilization: clamp(values.spend / 600),
        sublabel: `$${values.spend.toFixed(0)}/day`,
      },
      {
        id: "hot",
        label: "Hot index",
        kind: "storage",
        health: storeHealth,
        utilization: clamp(values.retainedTb / 30),
        sublabel: `${values.retainedTb.toFixed(1)} TB retained`,
      },
      {
        id: "archive",
        label: "Archive",
        kind: "storage",
        health: storeHealth,
        utilization: clamp(values.retention / 90),
        sublabel: `${values.retention} day window`,
      },
    ],
    edges: [
      edge("app-agent", "app", "agent", clamp(values.ingestGb / 1_500), "ok"),
      edge("agent-pipeline", "agent", "pipeline", clamp(values.ingestGb / 1_500), agentHealth),
      edge("pipeline-hot", "pipeline", "hot", clamp(values.spend / 600), pipelineHealth),
      edge("hot-archive", "hot", "archive", clamp(values.retainedTb / 30), storeHealth),
    ],
    metrics: [
      metric("daily-spend", "Daily log spend", values.spend, " $/day", 300, 600, "number"),
      metric("retained-volume", "Retained volume", values.retainedTb, " TB", 10, 25, "number"),
      metric("ingest-per-request", "Ingest per request", values.ingestPerRequestKb, " KB", 10, 16, "number"),
      metric("cost-per-request", "Cost per request", values.costPerRequestMicro, " µ$/req", 3, 6, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `$${values.spend.toFixed(0)}/day on ${values.ingestGb.toFixed(0)} GB/day; ${values.retainedTb.toFixed(1)} TB retained for ${values.retention} days; ${values.ingestPerRequestKb.toFixed(1)} KB per request.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "daily-spend",
    metricId: "daily-spend",
    warn: 300,
    crit: 600,
    title: "Log spend crossed the warning line",
    cause: "Volume or retention multiplied. The bill follows bytes ingested plus bytes retained, so a debug rollout and a long window compound.",
    fix: "Cut volume at the emitter before shortening retention. Levels, per-request lines, and debug sampling reduce every downstream copy; retention only shortens how long the copy lives.",
    checkFirst: [
      "Rank services by bytes per request, not total bytes.",
      "Compare the level distribution before and after the release.",
      "Check whether the affected stream is routed to a long-retention index.",
    ],
  },
  {
    id: "retained-volume",
    metricId: "retained-volume",
    warn: 10,
    crit: 25,
    title: "Retained log volume crossed the storage budget",
    cause: "Daily ingest multiplied by the retention window. A modest daily volume becomes a large stored volume when the window is long.",
    fix: "Move low-value events to a shorter tier or archive, shorten retention where policy allows, and reduce the source volume before extending the window.",
    checkFirst: [
      "Check retention per index, not the account default.",
      "Find the events that dominate retained bytes.",
      "Confirm any audit or legal retention floor before shortening.",
    ],
  },
  {
    id: "ingest-per-request",
    metricId: "ingest-per-request",
    warn: 10,
    crit: 16,
    title: "Per-request log volume is too high",
    cause: "A verbose release added lines per request or raised the debug share. The cost grows with traffic even if the retention window stays fixed.",
    fix: "Set levels per event, sample debug lines, and remove per-request lines that no incident query uses. Keep errors and audit events unsampled.",
    checkFirst: [
      "Compare lines per request for the top emitters.",
      "Find the release that changed the logger configuration.",
      "Check for loop or retry logging that multiplies lines.",
    ],
  },
  {
    id: "cost-per-request",
    metricId: "cost-per-request",
    warn: 3,
    crit: 6,
    title: "Log cost per request is above the unit budget",
    cause: "Telemetry cost is growing faster than traffic, which usually means more bytes or more retained copies per request rather than more users.",
    fix: "Make cost per request the owning team's metric. Cut volume at the source, sample debug, and tier retention by incident value.",
    checkFirst: [
      "Divide spend by request rate for the affected service.",
      "Compare with the previous release and the same hour last week.",
      "Check whether a new log field or body capture was added.",
    ],
  },
];

export const logVolumeCostModel: SimModel = {
  id: "observability-log-volume-cost",
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
    const jitter = 1 + rng.between(-0.005, 0.005);
    next.metrics = next.metrics.map((item) =>
      item.id === "daily-spend" ? { ...item, value: item.value * jitter } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.spend >= 600 && frame.flags.budgetSeen !== 1) {
      pushEvent(next, {
        id: "log-budget-exhausted",
        at: frame.t,
        severity: "crit",
        title: "The critical log budget line was crossed",
        detail: `Spend is $${values.spend.toFixed(0)}/day against a $600 critical line at ${values.ingestGb.toFixed(0)} GB/day and ${values.retention} days of retention. Per-request volume is ${values.ingestPerRequestKb.toFixed(1)} KB.`,
        nodeId: "pipeline",
        metricId: "daily-spend",
      });
      next.flags.budgetSeen = 1;
    }
    if (values.spend < 600) next.flags.budgetSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `$${values.spend.toFixed(0)}/day on ${values.ingestGb.toFixed(0)} GB/day; ${values.retainedTb.toFixed(1)} TB retained for ${values.retention} days; ${values.ingestPerRequestKb.toFixed(1)} KB per request.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(`${values.rps.toLocaleString()} rps × ${values.effectiveLines.toFixed(1)} retained lines × ${BYTES_PER_LINE} bytes produces ${values.ingestGb.toFixed(0)} GB/day.`);
    items.push(`Daily spend is about $${values.spend.toFixed(0)}; retained volume is ${values.retainedTb.toFixed(1)} TB over ${values.retention} days at the illustrative rates.`);
    items.push(`Debug lines are ${values.debugShare.toFixed(0)}% of the stream and ${values.sampling.toFixed(0)}% are kept. Sampling debug reduces volume without touching error or audit evidence.`);
    items.push(`Ingest per request is ${values.ingestPerRequestKb.toFixed(1)} KB. This is the multiplier that grows with traffic even when retention is fixed.`);
    return items;
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Approaching", tone: "warn" },
    { label: "Over budget", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "400 rps, 12 lines per request, 5% debug, and 15 days of retention.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Traffic triples, lines and debug share rise, and retention doubles. Spend is over the warning line.",
    tone: "warn",
    params: defaults({ requestRate: 1_400, linesPerRequest: 22, debugShare: 20, debugSampling: 30, retentionDays: 20 }),
  },
  {
    id: "failure",
    label: "Verbose release",
    description: "A debug rollout emits 60 lines per request at 2,000 rps and keeps them for 30 days.",
    tone: "crit",
    params: defaults({ requestRate: 2_000, linesPerRequest: 60, debugShare: 35, debugSampling: 100, retentionDays: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Sample debug, cut per-request lines, and shorten retention to 12 days. Error lines stay.",
    tone: "ok",
    params: defaults({ requestRate: 2_000, linesPerRequest: 12, debugShare: 5, debugSampling: 10, retentionDays: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-log-cost-lever",
  title: "Predict which lever keeps the evidence",
  simId: "log-volume-cost",
  question:
    "A verbose release spends $2,000 per day at 2,000 rps. The budget is $600, with a $300 warning line. Which change cuts spend most while keeping error and audit evidence?",
  prediction: {
    options: [
      { id: "disable", label: "Turn off application logging during the incident" },
      { id: "shorten", label: "Cut retention from 30 days to one day" },
      { id: "discipline", label: "Keep 10% of debug lines, cut lines per request, and keep error lines and a 12-day window" },
      { id: "tier", label: "Move the same volume to an archive tier and keep the hot window unchanged" },
    ],
    correctOptionId: "discipline",
    explanation:
      "Retention and tiering change the stored copy, but they do not reduce the bytes emitted per request or the ingest bill. Sampling debug and removing low-value lines cuts volume at the source, so every downstream copy shrinks. Error and audit lines stay unsampled, so the evidence an incident needs is still there.",
  },
  setup: defaults({ requestRate: 2_000, linesPerRequest: 60, debugShare: 35, debugSampling: 100, retentionDays: 30 }),
  runFor: 20,
  observe: [
    "Spend reaches about $2,000 per day against a $300 warning line and a $600 critical line.",
    "Retained volume reaches about 109 TB, and per-request ingest reaches 20.5 KB.",
    "The pipeline and hot-index nodes fail while the application keeps serving traffic.",
    "The billed bytes are set by effective lines per request, not by the request count alone.",
  ],
  explain:
    "The bill is volume times retention. At 2,000 rps and 60 lines per request, the emitter produces about 3,629 GB per day. Cutting the debug share to 5% (keeping 10% of those lines) and the request to 12 lines drops the effective volume to about 693 GB per day. Storage then falls with the shorter window. The lever that changes every copy is the one at the emitter.",
  fix: defaults({ requestRate: 2_000, linesPerRequest: 12, debugShare: 5, debugSampling: 10, retentionDays: 12 }),
  debrief:
    "The recovery preset cuts spend from about $2,000 to about $194 per day and retained volume from about 109 TB to about 8 TB. Error lines are untouched, and the 12-day window still covers the incident and the postmortem. The tradeoff is that sampled debug can miss the one line that explains a rare failure, so sample by event and keep the error path unsampled.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Log cost has two multipliers: how many bytes you send and how long you keep them. Ingest cost follows the bytes that arrive. Storage cost follows the retained volume, which is ingest multiplied by the retention window and the number of copies. A debug rollout changes the first multiplier; a long retention window changes the second. Cutting either one lowers the bill, but only volume reduction shrinks every downstream copy.",
  },
  {
    type: "p",
    text: "The main levers are the level, the number of lines per request, sampling, routing, and retention. Level and lines per request are set by the application. Sampling is usually applied to high-volume, low-value events such as debug lines. Routing sends streams to different indexes or tiers with different retention and query cost. Retention decides how long each copy lives.",
  },
  {
    type: "p",
    text: "Cost per request is a better unit than total spend because it separates growth from traffic. If request rate is flat and spend rises, the pipeline is emitting more bytes or keeping them longer. If both rise together, the service is growing. The metric makes the owning team's decision visible without waiting for finance.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application, log agent, ingest pipeline, hot index, then archive. The application sets the raw volume. The agent batches and can drop or sample. The pipeline parses, routes, and may add fields. The hot index is the expensive, queryable copy. The archive is cheaper per byte but often slower and harder to purge.",
  },
  {
    type: "table",
    headers: ["Lever", "What it reduces", "Evidence risk"],
    rows: [
      ["Tighten the level", "Lines that no incident query uses", "Loses detail for the next unknown failure"],
      ["Fewer lines per request", "Every downstream copy, immediately", "Can remove the step that explains a stall"],
      ["Sample debug", "High-volume low-value lines", "Rare debug path may disappear"],
      ["Route to a shorter tier", "Storage and query cost for low-value streams", "Shorter window for later investigation"],
      ["Shorten retention", "Stored volume, not ingest bytes", "Can violate audit or postmortem needs"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative rates: 350 bytes per line, $0.10 per GB ingested, and $0.015 per GB-day stored. They are teaching values, not a vendor quote. The structure is the lesson: a small per-request change multiplies across traffic and retention.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Daily log spend: the combined ingest and retained-copy cost.",
      "Retained volume: the storage footprint after the retention window.",
      "Ingest per request: the volume multiplier that grows with traffic.",
      "Cost per request: whether telemetry is growing faster than the service.",
      "Node health from the application through the hot index and archive.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Verbose release. Watch retained volume grow with retention even before you change traffic. Run the experiment before the debrief: predict which lever cuts spend while keeping error evidence, then apply the fix and compare per-request volume.",
  },
  {
    type: "compare",
    leftTitle: "Cut at the emitter",
    rightTitle: "Cut at storage",
    rows: [
      { label: "Ingest cost", left: "Falls immediately", right: "Unchanged" },
      { label: "Stored volume", left: "Falls with volume", right: "Falls only if retention or tier changes" },
      { label: "Every copy", left: "Shrinks, including archives and vendors", right: "Only the targeted copy" },
      { label: "Evidence risk", left: "Choose which events to keep", right: "Same events, shorter life" },
      { label: "Rollback", left: "Revert the logger config", right: "Restore retention, but deleted data is gone" },
    ],
  },
  { type: "sim", simId: "log-volume-cost" },
  { type: "experiment", experimentId: "predict-log-cost-lever" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The verbose release multiplied lines per request and kept every debug line. Ingest rose with traffic and retention multiplied the stored copy. The application kept serving traffic while the log pipeline crossed its budget, and the first clear signal was the bill, not an error rate. That is why log cost needs a product metric rather than a monthly finance review.",
  },
  {
    type: "p",
    text: "Sampling debug and cutting per-request lines reduced the bytes at the source, so every downstream copy shrank. Shortening retention reduced the remaining stored volume. Error and audit lines stayed, which is what made the recovery acceptable. Cutting logging entirely would have been cheaper and would have removed the evidence for the next incident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Datadog Log Management usage: ingested bytes, indexed bytes, and the retention settings for each index.",
      "Pipeline metrics: bytes per second by service, dropped events, and sampling counters.",
      "Application config: the logger level and the lines emitted per request after a release.",
      "Top emitters: services or loggers that dominate bytes even when their traffic is small.",
      "Archive and vendor usage: the copies that are easy to forget when the hot index is trimmed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Rank services by bytes per request, not total bytes. Compare lines per request before and after the release. Check the level distribution and the retention of the index that receives the stream. Shortening retention is not a substitute for reducing volume.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the release or logger change that increased lines per request.",
      "Remove or sample debug lines by event, keeping errors and audit events unsampled.",
      "Set levels per event so production does not emit development detail.",
      "Route low-value streams to a shorter tier; keep the incident-critical stream in the queryable index.",
      "Shorten retention only after checking audit and postmortem requirements.",
      "Track cost per request and bytes per request by service after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Sampling debug saves volume and can remove the one line that explains a rare failure; sample by event and keep errors unsampled.",
      "Shortening retention lowers storage and can break a postmortem or audit that needs older evidence.",
      "Moving data to a cheaper tier saves money and adds query latency, restore steps, and a second retention policy to manage.",
      "Fewer lines per request improves unit cost and can reduce observability for a dependency that later becomes the bottleneck.",
      "A hard budget can force a choice between evidence and cost; decide which events are worth keeping before the incident.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cost-model",
    question:
      "How would you estimate the monthly cost of a new debug log line before shipping it?",
    difficulty: 2,
    hints: [
      "Start from requests per second and bytes per line.",
      "Include retention and every copy, not just ingest.",
    ],
    answer:
      "I would multiply request rate by lines added per request, bytes per line, and seconds in the month to get ingested bytes. Then I would multiply by the ingest rate and add the stored volume: daily bytes times retention days times the storage rate. I would include every copy that receives the stream, such as the hot index, archive, and vendor. Finally I would divide by request volume to get cost per request, which is the number the owning team can track.",
    followUps: [
      "How would sampling change the estimate?",
      "What if the line is only emitted on errors?",
      "Which copy is easiest to overlook?",
    ],
    redFlags: [
      "Counts requests but not lines per request.",
      "Ignores retention.",
      "Forgets archive or vendor copies.",
    ],
    rubric: [
      "Computes ingest from rate, lines, and bytes.",
      "Adds retention and copies.",
      "Normalizes to cost per request.",
    ],
  },
  {
    id: "retention-vs-volume",
    question:
      "The bill is 3× over budget. Why is shortening retention not enough, and when is it the right lever?",
    difficulty: 2,
    hints: [
      "Ingest is paid when bytes arrive.",
      "Retention affects the stored copy.",
    ],
    answer:
      "Shortening retention reduces stored volume but not the bytes ingested, so the ingest part of the bill stays. It is the right lever when the stream is already lean and the cost is dominated by a long window, or when a low-value stream is kept far longer than any query uses. It is the wrong first lever when a verbose release multiplied lines per request, because the same bytes are still paid on arrival and every copy still receives them.",
    followUps: [
      "How would you tell which part of the bill dominates?",
      "What policy floor might prevent shortening?",
      "How does tiering differ from deletion?",
    ],
    redFlags: [
      "Assumes retention cuts all cost.",
      "Shortens without checking audit needs.",
      "Ignores ingest.",
    ],
    rubric: [
      "Separates ingest from storage.",
      "Names when retention is appropriate.",
      "Checks policy constraints.",
    ],
  },
  {
    id: "sampling-evidence",
    question:
      "How do you sample debug logs without losing the evidence needed for a rare failure?",
    difficulty: 3,
    hints: [
      "Sample by event and keep error paths unsampled.",
      "Consider a tail or error-biased policy.",
    ],
    answer:
      "I would sample at the event or logger level rather than uniformly across all lines, keep error and audit events unsampled, and preserve a small deterministic sample of debug for known high-risk paths. If the platform supports it, I would use error-biased or tail sampling so a request that ends in failure keeps its debug context. I would also measure what was dropped so the team knows the blind spot, and keep a temporary verbose switch for a bounded incident window.",
    followUps: [
      "What is the risk of sampling at the agent instead of the SDK?",
      "How would you test that an error path keeps its debug lines?",
      "What would you do for a one-off investigation?",
    ],
    redFlags: [
      "Samples everything uniformly.",
      "Drops error lines with debug.",
      "Has no measurement of what was lost.",
    ],
    rubric: [
      "Keeps errors and audit unsampled.",
      "Uses event or outcome-aware sampling.",
      "Measures dropped data and provides a bounded override.",
    ],
  },
  {
    id: "unit-cost",
    question:
      "Why is cost per request more useful than total log spend for an owning team?",
    difficulty: 2,
    hints: [
      "Separate growth from efficiency.",
      "A team controls lines per request and retention.",
    ],
    answer:
      "Total spend mixes traffic growth with efficiency. A team can grow and still be efficient, or stay flat and become wasteful. Cost per request normalizes for traffic, so a rise points to more bytes or longer retention per request, which the team controls. It also gives a budget the team can reason about before shipping a new field or level. I would pair it with bytes per request and retained volume so the cause is visible, not just the ratio.",
    followUps: [
      "What would make cost per request fall while total spend rises?",
      "How would you set a target for a new service?",
      "Which teams would you compare, and which would you not?",
    ],
    redFlags: [
      "Uses total spend only.",
      "Compares teams with different traffic shapes directly.",
      "Has no volume breakdown.",
    ],
    rubric: [
      "Normalizes for traffic.",
      "Ties the metric to team-controlled levers.",
      "Adds volume and retention context.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every service has a bytes-per-request and cost-per-request view.",
      "Log levels are set per event, and debug is sampled in production.",
      "Error and audit events are routed to an unsampled stream.",
      "Each index has an owner, a retention setting, and a query purpose.",
      "A budget alert fires on cost per request, not only total spend.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the release or config change that raised lines per request.",
      "Cut volume at the emitter before shortening retention.",
      "Keep error and audit evidence unsampled.",
      "Check archive, vendor, and dead-letter copies before declaring savings.",
      "Record the before and after bytes per request.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression check for lines per request on the affected path.",
      "Review retention against postmortem and audit needs.",
      "Remove temporary verbose switches and reconcile the sampled stream.",
      "Report savings per request, not just the monthly total.",
    ],
  },
];

const references = [
  {
    title: "Log Management Billing",
    url: "https://docs.datadoghq.com/account_management/billing/log_management/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "How log ingest, indexing, and retention contribute to usage and billing.",
  },
  {
    title: "Log Indexes",
    url: "https://docs.datadoghq.com/logs/log_configuration/indexes/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Index filters, retention, and routing decisions that change stored volume.",
  },
  {
    title: "Logs",
    url: "https://opentelemetry.io/docs/concepts/signals/logs/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Log signal concepts and how telemetry pipelines carry log records.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "log-volume-cost": {
      model: logVolumeCostModel,
      presets,
      instructions:
        "Start Healthy, then apply Verbose release. Compare per-request ingest with retained volume, then run the experiment and apply the volume fix. Retention alone does not reduce ingest.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Bytes per line and the two rates are teaching values, not vendor prices.",
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
    "observability-telemetry-cost",
    "capacity-observability-cost",
  ],
};
