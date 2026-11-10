import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AUDIT_WINDOW_DAYS = 365;
const DISK_CAPACITY_GB = 2_000;
const SAMPLES_PER_DAY = 5_760;
const RAW_BYTES_PER_SAMPLE = 1.2;
const DOWNSAMPLED_BYTES_PER_SAMPLE = 1.8;

const params = [
  {
    id: "series",
    label: "Ingested series",
    min: 100_000,
    max: 10_000_000,
    step: 100_000,
    value: 2_000_000,
    unit: " series",
    scale: "log" as const,
    group: "Volume",
    help: "Active series written per day. More series multiply every retention tier.",
    format: "count" as const,
  },
  {
    id: "rawRetentionDays",
    label: "Raw retention",
    min: 7,
    max: 365,
    step: 7,
    value: 30,
    unit: " d",
    group: "Tiers",
    help: "Days kept at the original scrape resolution before downsampling.",
    format: "number" as const,
  },
  {
    id: "downsampledRetentionDays",
    label: "Total retention",
    min: 30,
    max: 1_825,
    step: 5,
    value: 365,
    unit: " d",
    group: "Tiers",
    help: "Days kept after downsampling. The audit window is 365 days; if this is below raw retention, the larger value is used as total.",
    format: "number" as const,
  },
  {
    id: "downsampleResolution",
    label: "Downsample interval",
    min: 60,
    max: 3_600,
    step: 60,
    value: 300,
    unit: " s",
    scale: "log" as const,
    group: "Tiers",
    help: "One sample kept per interval after the raw tier. Coarser intervals save more disk and lose more detail.",
    format: "number" as const,
  },
  {
    id: "queryWindowDays",
    label: "Query window",
    min: 1,
    max: 365,
    step: 1,
    value: 30,
    unit: " d",
    group: "Query",
    help: "Time range scanned by a dashboard or audit query.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  series: number;
  rawRetentionDays: number;
  downsampledRetentionDays: number;
  downsampleResolution: number;
  queryWindowDays: number;
  rawDays: number;
  totalDays: number;
  downDays: number;
  rawGB: number;
  downGB: number;
  diskGB: number;
  diskUsed: number;
  diskOverGB: number;
  auditGap: number;
  queryP95: number;
  downsamplerCpu: number;
}

function compute(p: Params): Computed {
  const series = Math.max(1, Math.round(num(p, "series", 2_000_000)));
  const rawRetentionDays = Math.max(1, Math.round(num(p, "rawRetentionDays", 30)));
  const downsampledRetentionDays = Math.max(1, Math.round(num(p, "downsampledRetentionDays", 365)));
  const downsampleResolution = Math.max(1, Math.round(num(p, "downsampleResolution", 300)));
  const queryWindowDays = Math.max(1, num(p, "queryWindowDays", 30));
  const rawDays = Math.min(rawRetentionDays, downsampledRetentionDays);
  const totalDays = Math.max(rawRetentionDays, downsampledRetentionDays);
  const downDays = Math.max(0, totalDays - rawDays);
  const rawGB = (series * SAMPLES_PER_DAY * rawDays * RAW_BYTES_PER_SAMPLE) / 1e9;
  const downGB = (series * (86_400 / downsampleResolution) * downDays * DOWNSAMPLED_BYTES_PER_SAMPLE) / 1e9;
  const diskGB = rawGB + downGB;
  const rawPoints = Math.min(queryWindowDays, rawDays) * SAMPLES_PER_DAY;
  const downPoints = Math.max(0, queryWindowDays - rawDays) * (86_400 / downsampleResolution);
  const points = rawPoints + downPoints;
  return {
    series,
    rawRetentionDays,
    downsampledRetentionDays,
    downsampleResolution,
    queryWindowDays,
    rawDays,
    totalDays,
    downDays,
    rawGB,
    downGB,
    diskGB,
    diskUsed: Math.min(100, (diskGB / DISK_CAPACITY_GB) * 100),
    diskOverGB: Math.max(0, diskGB - DISK_CAPACITY_GB),
    auditGap: Math.max(0, AUDIT_WINDOW_DAYS - totalDays),
    queryP95: 40 + 0.0008 * Math.sqrt(series * Math.max(1, points)),
    downsamplerCpu: clamp(20 + (downGB / DISK_CAPACITY_GB) * 50, 0, 100),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function diskSummary(values: Computed): string {
  const capacity = DISK_CAPACITY_GB.toLocaleString();
  if (values.diskOverGB > 0) {
    return `${values.diskGB.toFixed(0)}GB required; ${values.diskOverGB.toFixed(0)}GB over the ${capacity}GB disk`;
  }
  return `${values.diskGB.toFixed(0)}GB required; ${(DISK_CAPACITY_GB - values.diskGB).toFixed(0)}GB free on the ${capacity}GB disk`;
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["disk-used", values.diskUsed],
    ["audit-gap", values.auditGap],
    ["query-p95", values.queryP95],
    ["ingest-series", values.series],
    ["resolution-at-edge", values.downsampleResolution],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.5);
      return Math.max(0, value * (0.97 + 0.03 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const rawHealth = healthFor((values.rawGB / DISK_CAPACITY_GB) * 100, 75, 95);
  const diskHealth = healthFor(values.diskUsed, 75, 95);
  const auditHealth = healthFor(values.auditGap, 1, 30);
  const queryHealth = healthFor(values.queryP95, 600, 1_500);
  const auditCoverage = Math.min(100, (values.totalDays / AUDIT_WINDOW_DAYS) * 100);
  return {
    t: 0,
    nodes: [
      {
        id: "ingest",
        label: "Ingest",
        kind: "stream",
        health: healthFor(values.series, 8_500_000, 9_500_000),
        utilization: clamp(values.series / 10_000_000),
        sublabel: `${values.series.toLocaleString()} series`,
        detail: "Every series is written to the raw tier first.",
        meta: { view: "flow" },
      },
      {
        id: "raw",
        label: "Raw store",
        kind: "storage",
        health: rawHealth,
        utilization: clamp(values.rawGB / DISK_CAPACITY_GB),
        sublabel: `${values.rawGB.toFixed(0)}GB / ${values.rawDays}d`,
        detail: `Raw samples at the scrape interval for ${values.rawDays} days.`,
        meta: { view: "flow" },
      },
      {
        id: "downsampler",
        label: "Downsampler",
        kind: "worker",
        health: healthFor(values.downsamplerCpu, 70, 85),
        utilization: values.downsamplerCpu / 100,
        sublabel: `${values.downsampleResolution}s interval`,
        detail: "Downsampling runs during background merges and keeps one raw sample per interval; it does not average.",
        meta: { view: "flow" },
      },
      {
        id: "archive",
        label: "Audit coverage",
        kind: "storage",
        health: auditHealth,
        utilization: auditCoverage / 100,
        sublabel: `${Math.min(values.totalDays, AUDIT_WINDOW_DAYS)}d of ${AUDIT_WINDOW_DAYS}d`,
        detail: `${values.downGB.toFixed(0)}GB of downsampled samples for ${values.downDays} days beyond the raw tier.`,
        meta: { view: "flow" },
      },
      {
        id: "disk",
        label: "Disk capacity",
        kind: "storage",
        health: diskHealth,
        utilization: values.diskUsed / 100,
        sublabel: `${values.diskGB.toFixed(0)}GB required`,
        detail: `${diskSummary(values)}. Model capacity is a teaching value, not a VictoriaMetrics limit.`,
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "Query path",
        kind: "service",
        health: queryHealth,
        utilization: clamp(values.queryP95 / 1_500),
        sublabel: `p95 ${values.queryP95.toFixed(0)}ms`,
        detail: `A ${values.queryWindowDays}-day query reaches p95 ${Math.round(values.queryP95)}ms at the modeled resolution.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("ingest-raw", "ingest", "raw", clamp(values.series / 10_000_000)),
      edge("raw-downsampler", "raw", "downsampler", clamp(values.rawGB / DISK_CAPACITY_GB), rawHealth),
      edge("downsampler-archive", "downsampler", "archive", clamp(values.downGB / DISK_CAPACITY_GB), auditHealth),
      edge("archive-disk", "archive", "disk", clamp(values.diskUsed / 100), diskHealth),
      edge("archive-query", "archive", "query", clamp(values.queryWindowDays / AUDIT_WINDOW_DAYS), queryHealth),
    ],
    metrics: [
      metric("disk-used", "Disk used", values.diskUsed, "%", 75, 95, "percent"),
      metric("audit-gap", "Audit gap", values.auditGap, " d", 1, 30, "number"),
      metric("query-p95", "Query p95", values.queryP95, "ms", 600, 1_500, "ms"),
      metric("ingest-series", "Ingested series", values.series, " series", 8_500_000, 9_500_000, "count"),
      metric("resolution-at-edge", "Edge resolution", values.downsampleResolution, "s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: `${diskSummary(values)}; audit gap ${values.auditGap} days; query p95 ${values.queryP95.toFixed(0)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "audit-gap",
    metricId: "audit-gap",
    warn: 1,
    crit: 30,
    title: "Retention is shorter than the audit window",
    cause:
      "The total retention tier was shortened to save disk, but the audit requirement still needs the full window. Data older than the total retention is deleted and cannot be queried.",
    fix:
      "Restore the total retention to at least the audit window, then reduce cost with a coarser downsampled tier, fewer series, or a separate archive. Do not meet a disk target by deleting required evidence.",
    checkFirst: [
      "Confirm the audit window in writing with compliance.",
      "Check which tiers count toward the requirement.",
      "Check whether an export or archive already preserves older data.",
    ],
  },
  {
    id: "disk-used",
    metricId: "disk-used",
    warn: 75,
    crit: 95,
    title: "Retention has filled the disk",
    cause:
      "Disk grows with series count, samples per series, and the days kept. A retention cut can free space, but it may delete evidence the audit requires.",
    fix:
      "Reduce the series count or downsample earlier before shortening the required retention. If the audit window must stay, a coarser tier is safer than deleting the tier.",
    checkFirst: [
      "Compare disk growth with series growth and retention changes.",
      "Check raw versus downsampled storage by tier.",
      "Check per-node free space and read-only state.",
    ],
  },
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 600,
    crit: 1_500,
    title: "Long-range queries are too slow",
    cause:
      "A wide query scans many points per series. Downsampling lowers the points scanned, but it also lowers the resolution available for incident reconstruction.",
    fix:
      "Use a coarser tier for long-range dashboards and keep a shorter raw tier for incidents. Separate the audit query path from the interactive dashboard path.",
    checkFirst: [
      "Compare the query window with the raw tier boundary.",
      "Check the number of series the query matches.",
      "Check whether the panel needs raw resolution or only a trend.",
    ],
  },
  {
    id: "ingest-series",
    metricId: "ingest-series",
    warn: 8_500_000,
    crit: 9_500_000,
    title: "Series volume is making every tier expensive",
    cause:
      "Retention multiplies the cost of every series. A high series count makes even a short raw tier and a coarse archive expensive.",
    fix:
      "Reduce cardinality before tuning retention. A label fix lowers all tiers at once; a retention cut only removes history.",
    checkFirst: [
      "Rank metrics and labels by series count.",
      "Check whether the series growth is justified by a product question.",
      "Check whether a downsampled tier still needs every series.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const retentionModel: SimModel = {
  id: "observability-victoriametrics-retention",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults());
    seedSeries(frame, compute(defaults()));
    frame.flags.seed = seed;
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p);
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.auditGap >= 30 && frame.flags.auditEvent !== 1) {
      pushEvent(next, {
        id: "retention-audit-delete",
        at: frame.t,
        severity: "crit",
        title: "Retention is shorter than the audit window",
        detail: `Total retention is ${values.totalDays} days, leaving a ${values.auditGap}-day gap against the ${AUDIT_WINDOW_DAYS}-day requirement. ${diskSummary(values)}.`,
        nodeId: "archive",
        metricId: "audit-gap",
      });
      next.flags.auditEvent = 1;
    }
    if (values.auditGap < 30) next.flags.auditEvent = 0;
    next.summary = `${diskSummary(values)}; audit gap ${values.auditGap} days; query p95 ${values.queryP95.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Raw tier: ${values.series.toLocaleString()} series x ${SAMPLES_PER_DAY.toLocaleString()} samples/day x ${values.rawDays} days = ${values.rawGB.toFixed(0)}GB.`,
    );
    items.push(
      `Downsampled tier: ${values.downDays} days at one sample per ${values.downsampleResolution}s = ${values.downGB.toFixed(0)}GB.`,
    );
    items.push(diskSummary(values) + ".");
    if (values.auditGap > 0) {
      items.push(`The ${AUDIT_WINDOW_DAYS}-day audit window has a ${values.auditGap}-day gap; disk savings came from deleting required history.`);
    } else {
      items.push(`The ${AUDIT_WINDOW_DAYS}-day audit window is covered by the total retention tier.`);
    }
    return items;
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
    description: "30 days raw, 365 days downsampled to five minutes, on 2 million series.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak growth",
    description: "Double the series at the same retention tiers. Disk and query cross warning.",
    tone: "warn",
    params: defaults({ series: 4_000_000 }),
  },
  {
    id: "failure",
    label: "Retention cut",
    description: "Total retention falls to 90 days to free disk. The audit window is now 275 days short.",
    tone: "crit",
    params: defaults({ series: 8_000_000, rawRetentionDays: 7, downsampledRetentionDays: 90, downsampleResolution: 60, queryWindowDays: 90 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Keep 365 days, drop raw to 7 days, and downsample to ten minutes.",
    tone: "ok",
    params: defaults({ series: 8_000_000, rawRetentionDays: 7, downsampledRetentionDays: 365, downsampleResolution: 600, queryWindowDays: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-retention-cut",
  title: "Predict what a retention cut preserves",
  simId: "vm-retention",
  question:
    "Compliance needs 365 days of evidence. Disk is full, so the team shortens total retention to 90 days. What happens?",
  prediction: {
    options: [
      { id: "audit", label: "Disk may fall, but the 275-day audit gap deletes required evidence" },
      { id: "safe", label: "Disk falls and the audit requirement is still met" },
      { id: "query", label: "Only query latency rises; retention is unchanged" },
      { id: "series", label: "The series count falls, so memory and disk both recover" },
    ],
    correctOptionId: "audit",
    explanation:
      "Retention controls how long data exists, not how many series exist. Cutting the total tier to 90 days leaves a 275-day gap against a 365-day requirement. It can reduce disk, but the reduction comes from deleting the evidence the audit needs.",
  },
  setup: defaults({ series: 8_000_000, rawRetentionDays: 7, downsampledRetentionDays: 90, downsampleResolution: 60, queryWindowDays: 90 }),
  runFor: 20,
  observe: [
    "Disk remains at 100% because 8 million series at one-minute resolution still require 2,108GB, which is 108GB over the 2,000GB disk.",
    "The audit gap is 275 days and the long-term store no longer covers the requirement.",
    "Queries over 90 days are slower than the 30-day healthy baseline.",
    "The series count is unchanged; retention tuning did not address cardinality.",
  ],
  explain:
    "Retention and cardinality are different multipliers. Retention sets how many days of samples exist per series. Cardinality sets how many series exist. Cutting the days can free disk, but it cannot preserve one year of evidence. With 8 million series and a one-minute archive, the remaining 90 days still exceed the teaching disk, so the cut did not even solve the capacity problem.",
  fix: defaults({ series: 8_000_000, rawRetentionDays: 7, downsampledRetentionDays: 365, downsampleResolution: 600, queryWindowDays: 30 }),
  debrief:
    "Keeping 365 days at a ten-minute archive and only seven days raw brings disk below the warning line while covering the audit window. The tradeoff is resolution: long-range queries can see the trend but not the one-minute spike. The right answer is a tiered policy, not one retention number for every question.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Retention is how long a time-series store keeps samples. A retention policy can have tiers: a raw tier at the scrape interval for recent incident work, and a downsampled tier for long-range trends and audit evidence. Downsampling keeps one sample per interval, often the last raw sample in that interval, so the long-range shape survives while the point count falls.",
  },
  {
    type: "p",
    text: "Retention is a cost and evidence decision, not only a storage setting. Disk grows with series count, samples per series per day, and days kept. Shortening retention reduces disk, but it also deletes history. If an audit or investigation needs that history, the saving is borrowed from a requirement the team cannot meet later.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Samples land in the raw tier, are downsampled during background merges, and move into a long-term tier. Queries read the finest tier that covers their window. In VictoriaMetrics, downsampling is configured with `-downsampling.period` and is an Enterprise feature; it keeps one raw sample per interval and does not average. It reduces points, not the number of series, so it helps high-sample-density series and does little for high-churn series with few samples each.",
  },
  {
    type: "table",
    headers: ["Tier", "Resolution", "Answers", "Cost"],
    rows: [
      ["Raw", "Scrape interval", "Incident spikes, exact values", "Highest disk per day"],
      ["Downsampled", "Minutes to hours", "Trends, capacity, audit ranges", "Much lower disk per day"],
      ["Archive or export", "Policy-defined", "Legal hold or long-term evidence", "Separate system and access path"],
    ],
  },
  {
    type: "p",
    text: "The model assumes a 365-day audit window, a 2TB teaching disk, 5,760 samples per series per day, and fixed compressed bytes per sample. Those are not VictoriaMetrics limits or legal requirements. The audit window must come from the organization's policy and counsel, not from a monitoring default.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Disk used with warning at 75% and critical at 95%.",
      "Audit gap in days: how far total retention falls short of the 365-day requirement.",
      "Query p95 for the selected window, which changes with the raw and downsampled resolution.",
      "Raw and downsampled storage shown separately, so the tier that grew is visible.",
      "Ingested series, which multiplies every tier and is not fixed by retention tuning.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that the audit window is covered at 38% disk. Apply Retention cut. Watch disk stay high while the audit gap opens. Then apply Recovery and compare resolution and coverage. Run the experiment before reading the debrief.",
  },
  {
    type: "p",
    text: "A retention cut is easy to measure and hard to reverse. Once the older samples are deleted, restoring the window does not bring them back. Treat the audit window as a constraint and tune resolution, cardinality, or the archive path around it.",
  },
  { type: "sim", simId: "vm-retention" },
  { type: "experiment", experimentId: "predict-retention-cut" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The retention cut moved the total tier from 365 to 90 days. That created a 275-day audit gap immediately, while disk stayed above the critical line because 8 million series at a one-minute resolution still produced more than 2TB. The cut deleted evidence and did not solve the capacity problem.",
  },
  {
    type: "p",
    text: "The recovery kept the full year but split the tiers: seven days raw and 358 days at a ten-minute interval. Disk fell below the warning line and the audit gap closed. The cost is resolution. A long-range query can still show the weekly trend, but it cannot show a one-minute spike from eleven months ago.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "vmstorage disk usage by tier, with retention flags and the oldest available timestamp.",
      "An audit query that returns no data before the retention boundary, even though the dashboard still shows the range.",
      "Downsampling configuration and merge behavior; downsampling runs in the background and may lag after a change.",
      "Series count growth that makes every tier more expensive, independent of retention.",
      "A legal or compliance request that arrives after the data was deleted; the gap is not recoverable from the metric store.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the oldest available sample with the audit window before changing retention. Confirm which tier satisfies the requirement. Then check disk by tier and series count, because retention is only one of the multipliers.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the audit window and the evidence format with compliance in writing.",
      "Restore total retention to cover the window before any further deletion.",
      "Reduce raw retention and keep a coarser long-term tier for trends.",
      "Reduce series count or aggregate high-churn series before extending retention.",
      "Export required evidence to a separate archive if the metric store cannot meet the hold requirement.",
      "Verify the oldest queryable timestamp and the disk headroom after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Coarser downsampling saves disk but loses spike detail. Do not use it for the tier that must reconstruct an incident.",
      "A longer raw tier is expensive and usually unnecessary; most incident work happens in the first days.",
      "Downsampling keeps one raw sample, not an average, so gauges and summaries can lose changes within the interval.",
      "Downsampling does not reduce series count, so it will not rescue a cardinality problem.",
      "An external archive preserves evidence but adds access latency, cost, and a second system to secure.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "retention-requirement",
    question:
      "Compliance asks for one year of metrics, dashboards need 30 days, and disk is full. How do you frame the decision?",
    difficulty: 2,
    hints: [
      "Separate the requirement from the dashboard preference.",
      "Resolution is a separate lever from retention.",
    ],
    answer:
      "I would treat the one-year requirement as a constraint and the 30-day dashboard need as a performance preference. First I would confirm what evidence the audit actually requires: raw samples, hourly aggregates, or a queryable export. Then I would keep a short raw tier for incident work and a coarse long-term tier that covers the full year, or export to an archive if the metric store cannot hold it. I would not shorten total retention below the requirement to solve disk. I would reduce cardinality and resolution instead.",
    followUps: [
      "What if compliance needs raw samples for the full year?",
      "How would you verify the oldest available sample?",
      "What does the archive cost in access time?",
    ],
    redFlags: [
      "Cuts retention to 30 days.",
      "Assumes downsampling satisfies every audit.",
      "Does not confirm the evidence format.",
    ],
    rubric: [
      "Separates requirement from preference.",
      "Confirms evidence format.",
      "Uses tiering or archive.",
      "Does not delete required history.",
    ],
  },
  {
    id: "downsample-effect",
    question:
      "What does VictoriaMetrics downsampling preserve, what does it lose, and when does it not help?",
    difficulty: 3,
    hints: [
      "One sample per interval, not an average.",
      "Points per series, not series count.",
    ],
    answer:
      "Downsampling keeps one raw sample per configured interval, usually the last sample with the biggest timestamp, for data older than the offset. It preserves the long-range shape and reduces points and disk. It loses changes inside the interval, which matters for gauges and summaries. It does not reduce the number of series, so it does not help high-churn data with few samples per series. It also runs during background merges and needs free disk and a writable storage node.",
    followUps: [
      "Which metric types suffer most?",
      "How would you test the loss before enabling it?",
      "Why can downsampling stall?",
    ],
    redFlags: [
      "Says downsampling averages.",
      "Assumes it reduces series count.",
      "Ignores merge and disk requirements.",
    ],
    rubric: [
      "States last-sample semantics.",
      "Names gauge and summary loss.",
      "Separates points from series.",
      "Mentions merge conditions.",
    ],
  },
  {
    id: "disk-full",
    question:
      "Disk is at 98% and a retention change will take hours to reclaim space. What do you do in the next ten minutes?",
    difficulty: 3,
    hints: [
      "Protect writes first.",
      "Deleting the wrong tier creates an audit gap.",
    ],
    answer:
      "I would protect the write path first: check whether vmstorage is read-only or near it, and free safe space such as temporary files or a non-required tier. I would not delete the tier that covers the audit window. I would reduce ingestion if the node is at risk, for example by dropping debug series or pausing a noisy target, and I would add capacity if that is faster than retention reclamation. Then I would fix the policy with a tiered plan and verify the oldest queryable timestamp afterward.",
    followUps: [
      "What would you drop first?",
      "How do you avoid deleting required evidence?",
      "What would you add to the runbook?",
    ],
    redFlags: [
      "Deletes the oldest tier immediately.",
      "Waits for retention to reclaim space.",
      "Ignores read-only state.",
    ],
    rubric: [
      "Protects writes.",
      "Preserves required evidence.",
      "Reduces ingestion safely.",
      "Verifies after the change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The audit window and required evidence format are documented with compliance.",
      "Raw and downsampled retention tiers have an owner and a disk budget.",
      "The oldest queryable timestamp is monitored against the requirement.",
      "Disk headroom and downsampling lag are visible per vmstorage node.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the oldest sample before changing retention.",
      "Do not delete the tier that covers the audit window.",
      "Reduce cardinality or raw resolution before total retention.",
      "Check whether downsampling is stalled on free disk or a read-only node.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify disk, oldest timestamp, and query latency after the change.",
      "Export or archive evidence that the metric store cannot hold.",
      "Record the retention decision and the resolution loss in the runbook.",
      "Review series growth so the next disk incident is not caused by cardinality.",
    ],
  },
];

const references = [
  {
    title: "Retention",
    url: "https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#retention",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Retention flags and how the store removes old data.",
  },
  {
    title: "Downsampling",
    url: "https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#downsampling",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Downsampling period syntax, last-sample semantics, and Enterprise availability.",
  },
  {
    title: "Guide to Computer Security Log Management",
    url: "https://csrc.nist.gov/pubs/sp/800/92/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Retention and log-management guidance; legal requirements still come from policy and counsel.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vm-retention": {
      model: retentionModel,
      presets,
      instructions:
        "Start Healthy, then apply Retention cut. Compare disk, audit gap, and query p95. Apply Recovery and change only the downsample interval to see the resolution tradeoff.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. The 365-day audit window, 2TB disk, compression ratios, and query curve are teaching values, not VictoriaMetrics limits or legal requirements.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-victoriametrics-cardinality",
    "observability-telemetry-cost",
    "foundations-linux-disk-io",
    "observability-victoriametrics-architecture",
  ],
};
