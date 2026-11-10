import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "scrapeInterval",
    label: "Scrape interval",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: "s",
    group: "Collection",
    help: "How often the agent or scraper collects a sample. Staleness cannot be fresher than this interval.",
    format: "number" as const,
  },
  {
    id: "silentAgents",
    label: "Silent agents",
    min: 0,
    max: 100,
    step: 1,
    value: 0,
    unit: "%",
    group: "Agents",
    help: "Share of expected agents that stop reporting. Partial loss can leave aggregate dashboards green.",
    format: "percent" as const,
  },
  {
    id: "ingestionLag",
    label: "Ingestion lag",
    min: 0,
    max: 300,
    step: 5,
    value: 2,
    unit: "s",
    group: "Pipeline",
    help: "Delay between the sample timestamp and the time the backend can query it. This is measured only for data that arrives.",
    format: "number" as const,
  },
  {
    id: "deadManWindow",
    label: "Dead man window",
    min: 1,
    max: 15,
    step: 1,
    value: 1,
    unit: " min",
    group: "Alerting",
    help: "How long the watchdog waits for a heartbeat before firing. A longer window is quieter and leaves a larger blind spot.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  scrapeInterval: number;
  silentAgents: number;
  ingestionLag: number;
  deadManWindow: number;
  coverage: number;
  staleness: number;
  detectionTime: number;
}

function compute(p: Params, silenceSeconds = 0, jitter = 0): Computed {
  const scrapeInterval = Math.max(1, num(p, "scrapeInterval", 15));
  const silentAgents = clamp(num(p, "silentAgents", 0), 0, 100);
  const ingestionLag = Math.max(0, num(p, "ingestionLag", 2));
  const deadManWindow = Math.max(1, num(p, "deadManWindow", 1));
  const coverage = 100 - silentAgents;
  const base = scrapeInterval + ingestionLag;
  const staleness = Math.max(
    0,
    base + (silentAgents >= 100 ? Math.max(0, silenceSeconds) : 0) + jitter,
  );
  return {
    scrapeInterval,
    silentAgents,
    ingestionLag,
    deadManWindow,
    coverage,
    staleness,
    detectionTime: deadManWindow * 60 + scrapeInterval + ingestionLag,
  };
}

function statusFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const agentHealth = statusFor(values.silentAgents, 1, 5);
  const backendHealth = statusFor(values.ingestionLag, 30, 120);
  const queryHealth = statusFor(values.staleness, 30, 60);
  const alertingHealth = statusFor(values.detectionTime, 180, 300);
  const pagerHealth: Health = "ok";

  return {
    t: 0,
    nodes: [
      {
        id: "targets",
        label: "Targets",
        kind: "service",
        health: "ok",
        sublabel: "applications and exporters",
        detail: "Targets keep producing telemetry even when no agent collects it. Their health is not evidence that the monitoring path is working.",
        meta: { view: "flow" },
      },
      {
        id: "agent",
        label: "Metrics agent",
        kind: "worker",
        health: agentHealth,
        utilization: clamp(values.coverage / 100),
        sublabel: `${values.coverage.toFixed(0)}% reporting`,
        detail: `${values.silentAgents.toFixed(0)}% of expected agents are silent. Coverage is ${values.coverage.toFixed(0)}%; aggregate queries can still look normal while a subset is missing.`,
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Metrics backend",
        kind: "storage",
        health: backendHealth,
        utilization: clamp(values.ingestionLag / 120),
        sublabel: `${values.ingestionLag.toFixed(0)}s ingestion lag`,
        detail: "Lag is the difference between sample time and query time for data that arrives. With no data, there is nothing to measure, so this signal can look healthy during a full outage.",
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "Dashboards",
        kind: "service",
        health: queryHealth,
        utilization: clamp(values.staleness / 60),
        sublabel: `newest sample ${values.staleness.toFixed(0)}s old`,
        detail: "A panel can render the last value or show no data. Neither state proves that new samples are arriving; the newest sample age does.",
        meta: { view: "flow" },
      },
      {
        id: "alerting",
        label: "Alert rules",
        kind: "service",
        health: alertingHealth,
        utilization: clamp(values.detectionTime / 300),
        sublabel: `watchdog ${values.deadManWindow} min`,
        detail: `A total outage would take about ${values.detectionTime.toFixed(0)}s to detect with a ${values.deadManWindow}-minute dead man window. Alert rules over an empty vector return no result. Notification delivery is not modelled here.`,
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "Pager",
        kind: "client",
        health: pagerHealth,
        sublabel: "notification path",
        detail: "Delivery is not modelled in this demo. Prove it with a test notification or an independent watchdog, not by the absence of alerts.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("targets-agent", "targets", "agent", clamp(values.coverage / 100), agentHealth),
      edge("agent-backend", "agent", "backend", clamp(values.coverage / 100), backendHealth),
      edge(
        "backend-query",
        "backend",
        "query",
        clamp(1 - values.staleness / 120),
        queryHealth,
      ),
      edge(
        "query-alerting",
        "query",
        "alerting",
        clamp(1 - values.detectionTime / 600),
        alertingHealth,
      ),
      edge(
        "alerting-pager",
        "alerting",
        "pager",
        1,
        pagerHealth,
      ),
    ],
    metrics: [
      metric("blind-spot", "Agent blind spot", values.silentAgents, "%", 1, 5, "percent"),
      metric("staleness", "Newest sample age", values.staleness, "s", 30, 60, "number"),
      metric("ingestion-lag", "Ingestion lag", values.ingestionLag, "s", 30, 120, "number"),
      metric("detection-time", "Outage detection time", values.detectionTime, "s", 180, 300, "number"),
      metric("coverage", "Agents reporting", values.coverage, "%", undefined, undefined, "percent"),
      metric("scrape-interval", "Scrape interval", values.scrapeInterval, "s", undefined, undefined, "number"),
      metric("deadman-window", "Dead man window", values.deadManWindow, " min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.coverage.toFixed(0)}% of agents reporting; newest sample ${values.staleness.toFixed(0)}s old; ingestion lag ${values.ingestionLag.toFixed(0)}s; total-outage detection ${values.detectionTime.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 5)) / 2.7);
  const entries: [string, number, number][] = [
    ["blind-spot", values.silentAgents, 0],
    ["staleness", values.staleness, 0.2],
    ["ingestion-lag", values.ingestionLag, 0.1],
    ["detection-time", values.detectionTime, 0],
    ["coverage", values.coverage, 0],
    ["scrape-interval", values.scrapeInterval, 0],
    ["deadman-window", values.deadManWindow, 0],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blind-spot",
    metricId: "blind-spot",
    warn: 1,
    crit: 5,
    title: "Agent blind spot exceeded the budget",
    cause:
      "Agents stopped reporting. Aggregate dashboards can stay green because the remaining agents still deliver data, and queries over the missing subset return no result rather than an error.",
    fix:
      "Find the missing agents by job, region, and version. Check network and agent health, then alert on expected target count instead of only on values from the targets that remain.",
    checkFirst: [
      "Compare expected and reporting agent counts per job and region.",
      "Check scrape success and the last successful collection time.",
      "Check the most recent network, credential, or configuration change.",
    ],
  },
  {
    id: "staleness",
    metricId: "staleness",
    warn: 30,
    crit: 60,
    title: "The newest metric sample is too old",
    cause:
      "No fresh samples are arriving for the queried series. Dashboards may show the last value indefinitely, so a green panel can be a stale panel.",
    fix:
      "Treat no data as an alert, add absent() or absent_over_time() rules, and check the agent-to-backend path. Do not infer health from a value that did not arrive.",
    checkFirst: [
      "Compare the newest sample timestamp with the current time.",
      "Check the panel's lookback and no-data settings.",
      "Check whether only one job or every job is stale.",
    ],
  },
  {
    id: "ingestion-lag",
    metricId: "ingestion-lag",
    warn: 30,
    crit: 120,
    title: "Ingestion lag is growing",
    cause:
      "The pipeline is accepting data faster than it can index it, or the backend is slow. Lag measures delivered samples, so it can look normal when no samples arrive at all.",
    fix:
      "Check collector queue and backend write latency, shed or sample load, and add capacity. Do not add buffering without a time bound; it increases lag and delays evidence.",
    checkFirst: [
      "Compare producer timestamps with ingest timestamps.",
      "Check collector exporter queue size and capacity.",
      "Check backend throttle responses, write latency, and disk pressure.",
    ],
  },
  {
    id: "detection-time",
    metricId: "detection-time",
    warn: 180,
    crit: 300,
    title: "A total outage would go unnoticed for too long",
    cause:
      "The dead man window is longer than the response budget. A silent pipeline waits for the full window before the watchdog fires, and every minute of that window is a blind spot.",
    fix:
      "Shorten the watchdog window to a few missed heartbeats, keep the heartbeat path independent of the pipeline, and test it by stopping collection.",
    checkFirst: [
      "Check the watchdog interval and the alert route to the pager.",
      "Confirm the watchdog does not share the failed agent, backend, or network path.",
      "Run a game day that stops collection and measures detection time.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const metaMonitoringModel: SimModel = {
  id: "observability-meta-monitoring",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const step = clamp(dt, 0.01, 1);
    const jitter = rng.between(-0.2, 0.2);
    const silent = num(p, "silentAgents", 0) >= 100;
    const rawSilence = frame.flags.silenceSeconds;
    const previousSilence =
      typeof rawSilence === "number" && Number.isFinite(rawSilence)
        ? Math.max(0, rawSilence)
        : 0;
    const silenceSeconds = silent ? previousSilence + step : 0;
    const values = compute(p, silenceSeconds, jitter);
    const next = buildFrame(Number(frame.flags.seed ?? 20261110), values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.silenceSeconds = silenceSeconds;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (values.silentAgents >= 100 && frame.flags.silenceSeen !== 1) {
      pushEvent(next, {
        id: "metrics-silent",
        at: frame.t + step,
        severity: "crit",
        title: "All metrics agents are silent",
        detail: `Coverage is 0%. Staleness is ${values.staleness.toFixed(0)}s and climbing; ingestion lag still reads ${values.ingestionLag.toFixed(0)}s because it only measures data that arrives.`,
        nodeId: "agent",
        metricId: "blind-spot",
      });
      next.flags.silenceSeen = 1;
    }
    if (values.silentAgents < 100) next.flags.silenceSeen = 0;

    if (
      values.silentAgents > 0 &&
      values.silentAgents < 100 &&
      frame.flags.partialSeen !== 1
    ) {
      pushEvent(next, {
        id: "coverage-degraded",
        at: frame.t + step,
        severity: "warn",
        title: "Agent coverage degraded",
        detail: `${values.silentAgents.toFixed(0)}% of agents are silent. Aggregate staleness may stay normal because the remaining agents still deliver data.`,
        nodeId: "agent",
        metricId: "blind-spot",
      });
      next.flags.partialSeen = 1;
    }
    if (values.silentAgents <= 0 || values.silentAgents >= 100) next.flags.partialSeen = 0;

    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.coverage.toFixed(0)}% of agents reporting; newest sample ${values.staleness.toFixed(0)}s old; ingestion lag ${values.ingestionLag.toFixed(0)}s; total-outage detection ${values.detectionTime.toFixed(0)}s.`;
    return next;
  },
  thresholds,
  insights: (frame) => {
    const blindSpot = frame.metrics.find((item) => item.id === "blind-spot")?.value ?? 0;
    const staleness = frame.metrics.find((item) => item.id === "staleness")?.value ?? 0;
    const lag = frame.metrics.find((item) => item.id === "ingestion-lag")?.value ?? 0;
    const detection = frame.metrics.find((item) => item.id === "detection-time")?.value ?? 0;
    const items: string[] = [];
    if (blindSpot >= 100) {
      items.push(
        "Every agent is silent. The dashboard still has the last values, and ingestion lag still reads a normal number because there are no new samples to measure.",
      );
    } else if (blindSpot > 0) {
      items.push(
        `${blindSpot.toFixed(0)}% of agents are silent. Aggregate staleness is ${staleness.toFixed(0)}s; partial loss alone does not necessarily make it grow, so a total-silence dead man switch will not fire.`,
      );
    } else {
      items.push(
        `All agents report and the newest sample is ${staleness.toFixed(0)}s old. Coverage and freshness are both healthy.`,
      );
    }
    if (detection >= 180) {
      items.push(
        `A total outage would take about ${detection.toFixed(0)}s to detect. The dead man window, not the scrape interval, sets that delay.`,
      );
    }
    if (lag >= 30) {
      items.push(
        `Ingestion lag is ${lag.toFixed(0)}s. The pipeline is delivering data, but it is too old for a fast incident decision.`,
      );
    }
    if (blindSpot > 0 && blindSpot < 100) {
      items.push(
        "The missing agents are invisible to checks that only ask whether any data arrived. Alert on expected target count, not only on aggregate values.",
      );
    }
    items.push(
      "An alert rule over an empty vector returns no result, not a failing value. Use absent() or absent_over_time(), or a dead man switch that expects a heartbeat.",
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
    description: "Every agent reports, the newest sample is 17s old, and the one-minute watchdog is awake.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "One percent of agents are silent and ingestion lag is 20s. Coverage and freshness warn; data still arrives.",
    tone: "warn",
    params: defaults({ silentAgents: 1, ingestionLag: 20, deadManWindow: 2 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "Every agent is silent and the dead man window is 10 minutes. Coverage and detection are critical at once.",
    tone: "crit",
    params: defaults({ silentAgents: 100, ingestionLag: 2, deadManWindow: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Agents report again and the watchdog returns to one minute.",
    tone: "ok",
    params: defaults({ silentAgents: 0, ingestionLag: 2, deadManWindow: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-silence",
  title: "Predict what fires first when every agent goes silent",
  simId: "meta-monitoring",
  question:
    "At 10:00 every metrics agent stops. Dashboards keep the last values, the dead man window is 10 minutes, and the scrape interval is 15s. Which signal fires first?",
  prediction: {
    options: [
      {
        id: "coverage",
        label: "The agent coverage alert fires immediately; the dead man switch waits for its window",
      },
      { id: "deadman", label: "The dead man switch fires immediately because no data arrived" },
      {
        id: "nothing",
        label: "Nothing fires because an empty query result is treated as zero and stays under threshold",
      },
      {
        id: "lag",
        label: "The ingestion lag alert fires because lag grows to 10 minutes",
      },
    ],
    correctOptionId: "coverage",
    explanation:
      "A dead man switch measures the absence of a heartbeat over its window, so it fires at the end of the window. Agent coverage is a direct signal that expected targets stopped reporting and can fire as soon as the missing set is evaluated. An alert rule over an empty vector returns no result, not a failing value.",
  },
  setup: defaults({ silentAgents: 100, deadManWindow: 10 }),
  runFor: 60,
  observe: [
    "Agent blind spot is 100% and critical on the first evaluation.",
    "Newest sample age starts at 17s, crosses warning at about 13s, and reaches critical before 60s.",
    "Ingestion lag stays at 2s because it is measured only on samples that arrive.",
    "Outage detection time is about 617s, so the ten-minute watchdog has not fired within the run.",
    "The watchdog has not fired at 60s; the immediate signal is coverage, not a page.",
  ],
  explain:
    "Absence of data is not a value. Prometheus alert rules over an empty vector return no alerts, and a dashboard can keep the last sample on screen. Coverage and staleness expose the blind spot, while a dead man switch bounds how long a total outage can remain silent. The window is the detection budget, not a property of the scrape.",
  fix: defaults({ silentAgents: 0, ingestionLag: 2, deadManWindow: 1 }),
  debrief:
    "Restoring the agents brings coverage to 100% and staleness back to one scrape plus lag. Shortening the watchdog to one minute lowers total-outage detection to about 77s. The tradeoff is more sensitivity to transient scrape misses, so the window must be longer than normal jitter and shorter than the response budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Meta-monitoring is telemetry about the telemetry system: did the scrape succeed, is the agent alive, how far behind is ingestion, is the newest sample fresh, and would an alert actually be delivered? It exists because most dashboards and alert rules answer questions about values. When no value arrives, the rule evaluates an empty vector, not a failing value. A green dashboard can mean healthy or blind.",
  },
  {
    type: "p",
    text: "Absence of data is not zero. A comparison against a threshold needs a sample; with no sample, there is no alert. Prometheus provides absent() and absent_over_time() for this reason. A dead man switch is a heartbeat that is expected at a known interval and alerts when it stops. Both are ways of turning silence into a signal.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is targets and exporters, agent or scraper, metrics backend, query and dashboards, alert rules, Alertmanager, and pager. Meta-monitoring observes each hop and also observes the alert delivery path. The dead man switch must not depend on the same agent, backend, or network path it is supposed to detect; otherwise it goes silent with the pipeline.",
  },
  {
    type: "table",
    headers: ["Signal", "What it proves", "What it misses"],
    rows: [
      ["Coverage", "How many expected agents or targets reported", "A target can report but send partial or wrong series"],
      ["Staleness", "The newest sample is recent", "Partial loss while some data still arrives"],
      ["Ingestion lag", "Delivered data arrived close to event time", "Total silence, because there are no samples to measure"],
      ["Dead man switch", "The heartbeat path and alert route are alive", "A silent agent that still sends the heartbeat"],
      ["Delivery test", "A notification can reach the pager", "Whether the content is actionable"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 15-second scrape, a 2-second ingestion delay, a one-minute default watchdog, and illustrative thresholds at 1% and 5% blind spot, 30 and 60 seconds of staleness, and 180 and 300 seconds of detection time. These are teaching values, not universal defaults. A real window must cover normal scrape jitter and stay inside the response budget. The demo runs in seconds so the blind spot is visible in one pass; production windows are set from the response budget.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Agent blind spot and coverage against the expected target count.",
      "Newest sample age and ingestion lag, which fail differently.",
      "Outage detection time implied by the dead man window.",
      "Node states for targets, agent, backend, dashboards, alert rules, and pager.",
      "The gap between a green dashboard and a critical coverage alert.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Failure. Watch the blind spot go critical immediately while staleness takes tens of seconds and ingestion lag stays normal. That is the blind spot a value-only dashboard cannot show. Run the experiment before reading the answer.",
  },
  { type: "sim", simId: "meta-monitoring" },
  { type: "experiment", experimentId: "predict-silence" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Every agent went silent at once. The blind spot reached 100% on the first evaluation. Staleness started at one scrape plus the last ingestion delay and then grew with simulated time, crossing warning and critical inside a minute. Ingestion lag stayed at 2 seconds because it is computed from samples that arrive; with no samples, there is nothing to measure. The ten-minute dead man window put total-outage detection at about 617 seconds, so at 60 seconds the watchdog had not fired.",
  },
  {
    type: "p",
    text: "The dashboard still had the last values; its freshness signal crossed warning at about 13 seconds and critical at about 43 seconds. An alert rule comparing a missing series to a threshold returned no result. The recovery preset restored agents and shortened the window. Coverage returned to 100%, staleness returned to about 17 seconds, and detection time returned to about 77 seconds. The remaining tradeoff is the watchdog window: shorter catches silence sooner and pages on transient misses; longer is quieter and leaves a larger blind spot.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus: up, scrape_duration_seconds, scrape_samples_scraped, and expected target count. A target with up equal to 0 is a direct agent signal.",
      "Agents and collectors: exporter queue size and capacity, send failures, refused records, retry counts, and process uptime.",
      "Backend: newest sample timestamp, ingest lag, write errors, and throttle responses.",
      "Alerting: Alertmanager notification totals and failures, rule evaluation duration, and a watchdog alert that must always be present.",
      "Dashboards: panels configured to show the last value or to treat no-data as OK. Those settings hide the outage; check them explicitly.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the newest sample timestamp with the wall clock, then compare expected and reporting agents. Decide whether the gap is partial or total before trusting ingestion lag, because lag cannot see a pipeline that has stopped delivering.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add absent() or absent_over_time() alerts for critical series and a dead man switch for the pipeline.",
      "Monitor expected coverage per job, region, and agent, not only the aggregate series count.",
      "Monitor ingestion lag separately from staleness; lag can look normal while nothing new arrives.",
      "Test alert delivery with a synthetic notification or watchdog, and route it through the same pager path.",
      "Make the watchdog independent of the pipeline it monitors, with its own credentials and network path.",
      "Run a game day: stop the agent, block the backend, and break the alert route one at a time. Record detection time for each.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short dead man window detects faster but pages on scrape jitter, deploys, and transient network errors.",
      "Coverage alerts catch partial loss but need an expected target count that stays current as the fleet changes.",
      "Synthetic heartbeats cost little but add a component that can itself fail; monitor the watchdog too.",
      "Staleness thresholds must account for scrape interval and normal ingestion delay, or they will be noisy.",
      "Meta-monitoring can become a second monitoring system. Keep it small, owned, and tested.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "green-but-empty",
    question:
      "Every dashboard is green, but no metrics have arrived for 20 minutes. What do you check first?",
    difficulty: 2,
    hints: [
      "Start with the age of the newest sample, not the value on the panel.",
      "Separate a partial agent loss from a total pipeline stop.",
    ],
    answer:
      "I would check the newest sample timestamp first and compare it with the wall clock. If every series is stale, I would move up the path: scrape success, agent liveness, backend ingest lag, and the alert delivery path. If only some jobs are stale, I would compare expected and reporting agents by job and region. I would also check whether the panel is configured to show the last value or to treat no-data as OK. The key is to avoid using the displayed value as evidence that data is arriving.",
    followUps: [
      "How would you tell a partial agent loss from a total outage?",
      "Which signal would you page on: staleness or ingestion lag?",
      "What would you check if only one region is missing?",
    ],
    redFlags: [
      "Trusts the green panel.",
      "Starts by restarting the backend.",
      "Confuses a stale value with a fresh one.",
    ],
    rubric: [
      "Checks sample timestamp and staleness first.",
      "Separates partial from total loss.",
      "Checks scrape and agent health.",
      "Inspects no-data panel settings.",
    ],
  },
  {
    id: "empty-vector",
    question:
      "Why does an alert rule on error rate fail to fire when the service stops sending metrics entirely?",
    difficulty: 2,
    hints: [
      "Think about what a comparison returns when the input vector is empty.",
      "A missing series is not the same as a zero-valued series.",
    ],
    answer:
      "An alert rule is an expression evaluated over a vector of samples. If no series match, the expression returns an empty result, and a comparison against a threshold has nothing to compare. That is not the same as a zero error rate. The rule needs an explicit absence signal, such as absent() or absent_over_time(), or a dead man switch that expects a heartbeat. I would also check the rule's no-data behavior and make sure the alert evaluates a series that exists even when the service is healthy.",
    followUps: [
      "What does absent() return when the series exists?",
      "How would you write a no-data alert for a whole job?",
      "Why is a synthetic zero-valued series a weak substitute?",
    ],
    redFlags: [
      "Assumes missing data becomes zero.",
      "Adds a threshold without an absence check.",
      "Ignores the alert rule's no-data setting.",
    ],
    rubric: [
      "Explains empty vector semantics.",
      "Names absent or a dead man switch.",
      "Checks no-data behavior.",
      "Distinguishes missing from zero.",
    ],
  },
  {
    id: "design-deadman",
    question:
      "How do you design and test a dead man switch for a metrics pipeline?",
    difficulty: 3,
    hints: [
      "The heartbeat must not share the failure domain it is meant to detect.",
      "The window is a detection budget, not a scrape interval.",
    ],
    answer:
      "I would run a small independent heartbeat through the alerting path at a known interval and alert when it is absent for a window longer than normal jitter. The heartbeat should use its own credentials and network path, or at least not depend on the same agent and backend that it monitors. The window should be a few missed heartbeats, short enough to fit the response budget and long enough to avoid paging on a single miss. I would test it in a game day by stopping collection and by breaking the alert route separately, and I would verify that the page reaches a human with an actionable message.",
    followUps: [
      "What happens if the watchdog depends on the same backend?",
      "How do you avoid paging on a deploy?",
      "How would you test the alert route without a real incident?",
    ],
    redFlags: [
      "Sends the heartbeat through the same agent.",
      "Uses a window shorter than the scrape interval.",
      "Never tests the page path.",
    ],
    rubric: [
      "Independent heartbeat and path.",
      "Window based on missed intervals and response budget.",
      "Tests both collection and delivery.",
      "Verifies a human receives the page.",
    ],
  },
  {
    id: "partial-blind-spot",
    question:
      "A dead man switch is quiet and the dashboards look normal, but 10% of agents have been silent for an hour. Why did nothing catch it, and what would?",
    difficulty: 3,
    hints: [
      "A total-silence switch is not a coverage check.",
      "Aggregate freshness stays normal while any agent still reports.",
    ],
    answer:
      "The dead man switch only proves that some heartbeat or some data is still arriving. If 90% of agents report, staleness and ingestion lag can look normal, and a total-silence switch never fires. What catches it is coverage against an expected target count, per job and region, plus scrape success and series-count comparisons against a baseline. I would alert on the missing fraction, not only on the aggregate value, and I would keep the expected inventory current so the denominator does not drift.",
    followUps: [
      "How do you maintain the expected target count?",
      "What if the missing agents are the only ones with a specific label?",
      "How would you test a partial-loss alert?",
    ],
    redFlags: [
      "Relies only on a dead man switch.",
      "Uses aggregate staleness as coverage.",
      "Has no expected target inventory.",
    ],
    rubric: [
      "Explains why total-silence checks miss partial loss.",
      "Uses expected coverage per job or region.",
      "Compares series counts with a baseline.",
      "Keeps the inventory current.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every critical metric has an absence alert or a dead man switch.",
      "The expected agent and target inventory is maintained per job, region, and version.",
      "Scrape success, staleness, ingestion lag, and alert delivery are monitored separately.",
      "The watchdog uses an independent path and has a tested route to the pager.",
      "Dashboards do not hide no-data behind a last-value or OK default.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the newest sample timestamp before trusting a panel value.",
      "Compare expected and reporting agents to tell partial loss from total silence.",
      "Check whether ingestion lag is measuring delivered data or nothing at all.",
      "Verify alert delivery with a test notification if the pager is quiet.",
      "Record the time the first signal fired and the time a human acknowledged it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the missing coverage or absence check that would have caught the gap.",
      "Reconcile the expected target inventory with the real fleet.",
      "Test the dead man switch by stopping collection and measuring detection time.",
      "Remove last-value defaults from critical dashboards.",
      "Review whether the watchdog shares a failure domain with the pipeline.",
    ],
  },
];

const references = [
  {
    title: "Monitoring",
    url: "https://sre.google/workbook/monitoring/",
    publisher: "Google SRE",
    kind: "docs" as const,
    note: "Monitoring strategy, data freshness, and testing alerting logic.",
  },
  {
    title: "Alerting rules",
    url: "https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Rule expressions, evaluation, and alert state.",
  },
  {
    title: "Query functions: absent and absent_over_time",
    url: "https://prometheus.io/docs/prometheus/latest/querying/functions/#absent",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Alerting when no time series exist for a metric and label combination.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "meta-monitoring": {
      model: metaMonitoringModel,
      presets,
      instructions:
        "Start Healthy, then apply Failure. Watch the blind spot go critical immediately while staleness takes tens of seconds and ingestion lag stays normal. Compare Recovery and the experiment result.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Scrape intervals, thresholds, and dead man windows are teaching values, not universal defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-log-pipeline-backpressure",
    "observability-symptom-alerting",
    "observability-slo-burn-rate",
    "observability-dashboard-question",
  ],
};
