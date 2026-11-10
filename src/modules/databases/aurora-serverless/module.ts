import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "peakAcu",
    label: "Peak demand",
    min: 2,
    max: 256,
    step: 2,
    value: 32,
    unit: " ACU",
    group: "Workload",
    help: "Capacity the workload needs at peak. Aurora capacity units (ACUs) bundle memory, CPU, and network in an illustrative unit.",
    format: "number" as const,
  },
  {
    id: "minAcu",
    label: "Minimum capacity",
    min: 0.5,
    max: 32,
    step: 0.5,
    value: 4,
    unit: " ACU",
    group: "Capacity",
    help: "Floor the cluster keeps available. A higher floor shortens scale-up but is billed even when idle.",
    format: "number" as const,
  },
  {
    id: "idleMinutes",
    label: "Idle before traffic",
    min: 0,
    max: 120,
    step: 5,
    value: 0,
    unit: " min",
    group: "Workload",
    help: "How long the workload was quiet. A long idle period with a low floor models a cold resume; short gaps model a warm cluster.",
    format: "number" as const,
  },
  {
    id: "poolSize",
    label: "Warm pool connections",
    min: 5,
    max: 500,
    step: 5,
    value: 60,
    unit: " conns",
    group: "Clients",
    help: "Connections already established and able to issue work. A cold pool adds connection setup and authentication to the first requests.",
    format: "count" as const,
  },
  {
    id: "scaleAcuPerSecond",
    label: "Scale-up rate",
    min: 0.5,
    max: 32,
    step: 0.5,
    value: 8,
    unit: " ACU/s",
    group: "Capacity",
    help: "How fast capacity grows toward demand in this model. Real scaling depends on the workload and the engine's control loop.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  peak: number;
  min: number;
  idle: number;
  pool: number;
  scale: number;
  cold: boolean;
  capacity: number;
  deficitPct: number;
  queueMs: number;
  coldPenaltyMs: number;
  poolPenaltyMs: number;
  latency: number;
  poolHitPct: number;
  health: Health;
}

function compute(p: Params, t: number): Computed {
  const peak = Math.max(1, num(p, "peakAcu", 32));
  const min = Math.max(0.5, num(p, "minAcu", 4));
  const idle = Math.max(0, num(p, "idleMinutes", 0));
  const pool = Math.max(0, num(p, "poolSize", 60));
  const scale = Math.max(0.1, num(p, "scaleAcuPerSecond", 8));
  const cold = idle >= 15 && min < 2;
  const warmAtStart = idle < 15 || min * 2 >= peak;
  const capacity = warmAtStart ? peak : Math.min(peak, min + Math.max(0, t) * scale);
  const deficitPct = Math.max(0, ((peak - capacity) / peak) * 100);
  const queueMs = Math.min(5_000, 80 * Math.max(0, peak / Math.max(0.5, capacity) - 1));
  const coldPenaltyMs = cold ? Math.max(0, 800 * (1 - t / 120)) : 0;
  const poolHit = clamp(pool / Math.max(1, peak * 4));
  const poolPenaltyMs = (1 - poolHit) * 50;
  const latency = 3 + queueMs + coldPenaltyMs + poolPenaltyMs;
  const health: Health = latency >= 500 || deficitPct >= 50 ? "crit" : latency >= 100 || deficitPct >= 20 ? "warn" : "ok";
  return {
    peak,
    min,
    idle,
    pool,
    scale,
    cold,
    capacity,
    deficitPct,
    queueMs,
    coldPenaltyMs,
    poolPenaltyMs,
    latency,
    poolHitPct: poolHit * 100,
    health,
  };
}

function formatAcu(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)} ACU`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["p99-latency", values.latency, 1],
    ["acu-capacity", values.capacity, 0.1],
    ["acu-deficit", values.deficitPct, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  return {
    t,
    nodes: [
      {
        id: "app",
        label: "Application pool",
        kind: "service",
        health: values.health,
        sublabel: `${values.pool} warm connections`,
        detail:
          "A warm pool issues queries immediately. A cold pool pays connection setup and authentication at the same moment the cluster is trying to scale.",
        meta: { view: "flow" },
      },
      {
        id: "cluster",
        label: "Aurora Serverless cluster",
        kind: "db",
        role: "primary",
        health: values.health,
        utilization: clamp(values.peak / Math.max(0.5, values.capacity)),
        sublabel: `${formatAcu(values.capacity)} of ${formatAcu(values.peak)}`,
        detail: values.cold
          ? "The cluster idled at its floor and must resume or scale before it can serve peak demand. The first requests queue while capacity catches up."
          : "The cluster is warm but capacity may still lag a fast ramp. Check the deficit, not just the current ACU value.",
        meta: { view: "flow", capacity: values.capacity, demand: values.peak },
      },
      {
        id: "storage",
        label: "Aurora storage",
        kind: "storage",
        health: "ok",
        sublabel: "shared, replicated",
        detail:
          "Serverless capacity changes compute, not the storage volume. Data remains, but the new capacity still has to warm caches and accept connections.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-cluster", "app", "cluster", clamp(values.pool / 500), values.health, "queries"),
      edge("cluster-storage", "cluster", "storage", 0.8, "ok", "I/O"),
    ],
    metrics: [
      metric("p99-latency", "Request p99", values.latency, " ms", 100, 500, "ms"),
      metric("acu-deficit", "Capacity deficit", values.deficitPct, "%", 20, 50, "percent"),
      metric("acu-capacity", "Current capacity", values.capacity, " ACU", undefined, undefined, "number"),
      metric("cold-penalty", "Resume penalty", values.coldPenaltyMs, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatAcu(values.capacity)} serving ${formatAcu(values.peak)} demand; deficit ${Math.round(
      values.deficitPct,
    )}%; p99 ${Math.round(values.latency)} ms; ${values.cold ? "cold resume" : "warm cluster"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 100,
    crit: 500,
    title: "Requests are waiting for capacity",
    cause:
      "The cluster is below the capacity the workload needs. A cold resume adds its own delay, and a small pool adds connection setup to the same requests.",
    fix:
      "Raise the minimum capacity, keep a warm pool, and pre-scale before known peaks. Reduce the cold-path work that runs at the same time as scale-up.",
    checkFirst: [
      "Compare current ACU capacity with the demand at the time of the spike.",
      "Check whether the cluster was idle long enough to resume from a low floor.",
      "Check pool connection counts and connection setup time.",
    ],
  },
  {
    id: "acu-deficit",
    metricId: "acu-deficit",
    warn: 20,
    crit: 50,
    title: "Capacity is more than 20% below demand",
    cause:
      "Scale-up is rate-limited and starts from the minimum capacity. A steep ramp, a long idle period, or a floor that is too low leaves a gap between demand and available ACUs.",
    fix:
      "Raise the floor, smooth the ramp with queueing or admission control, or move predictable batch work away from the interactive peak.",
    checkFirst: [
      "Read the ACU capacity and demand series together, not capacity alone.",
      "Check the time from ramp start to full capacity.",
      "Check whether the workload's own concurrency multiplied during the ramp.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const serverlessModel: SimModel = {
  id: "databases-aurora-serverless",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const t = frame.t + dt;
    const values = compute(p, t);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t);
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.latency >= 500 && frame.flags.coldLogged !== 1) {
      pushEvent(next, {
        id: "serverless-capacity-gap",
        at: t,
        severity: "crit",
        title: values.cold ? "Cold resume breaches the request timeout" : "Scale-up lags demand",
        detail: `${formatAcu(values.capacity)} is available for ${formatAcu(
          values.peak,
        )} of demand; p99 is ${Math.round(values.latency)} ms.`,
        nodeId: "cluster",
        metricId: "p99-latency",
      });
    }
    next.flags.coldLogged = values.latency >= 500 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 60);
    return [
      `At one minute into the ramp, capacity is ${formatAcu(values.capacity)} against ${formatAcu(
        values.peak,
      )} of demand. The deficit is what queues requests, not the minimum capacity by itself.`,
      values.cold
        ? "The cluster idled at a low floor, so the first requests pay resume and scale-up together. A higher floor keeps capacity resident but is billed while idle."
        : "The cluster starts warm, so the remaining risk is the ramp: capacity can still lag a sudden increase in demand.",
      `The pool contributes about ${Math.round(values.poolPenaltyMs)} ms of the p99 in this model. A cold pool makes the first requests slower even after ACUs are available.`,
      `Scale-up runs at ${values.scale} ACU/s in this model. Doubling that rate shortens the gap; raising the floor removes the coldest part of it.`,
      "Aurora Serverless changes compute capacity, not storage. The data and its durability do not depend on the ACU value, but caches and connections still have to warm.",
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
    description: "A warm cluster at 4 ACU scales quickly to a 32 ACU peak with a warm pool.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Ramp after idle",
    description: "A 20-minute gap leaves the cluster at 8 ACU; scaling to 64 ACU is still 25% short after 20 seconds.",
    tone: "warn",
    elapsed: 20,
    params: defaults({ peakAcu: 64, minAcu: 8, idleMinutes: 20, poolSize: 30, scaleAcuPerSecond: 2 }),
  },
  {
    id: "failure",
    label: "Cold resume",
    description: "A long idle period at 0.5 ACU plus a slow ramp leaves a 256 ACU workload waiting; p99 breaches the timeout.",
    tone: "crit",
    elapsed: 45,
    params: defaults({ peakAcu: 256, minAcu: 0.5, idleMinutes: 60, poolSize: 5, scaleAcuPerSecond: 0.5 }),
  },
  {
    id: "floor",
    label: "Capacity floor",
    description: "A 16 ACU floor keeps the cluster warm enough to serve a 64 ACU peak after 20 seconds.",
    tone: "ok",
    elapsed: 20,
    params: defaults({ peakAcu: 64, minAcu: 16, idleMinutes: 60, poolSize: 80, scaleAcuPerSecond: 4 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Short idle, a 16 ACU floor, and a warm pool keep p99 under 20 ms.",
    tone: "ok",
    params: defaults({ peakAcu: 32, minAcu: 16, idleMinutes: 10, poolSize: 100, scaleAcuPerSecond: 8 }),
  },
];

const experiment: Experiment = {
  id: "cold-resume-timeout",
  title: "Why the idle serverless database times out",
  simId: "aurora-serverless",
  question:
    "A serverless database is quiet overnight, then the first morning requests time out. The cluster is configured with a 0.5 ACU minimum and a slow scale-up. What dominates the first-minute latency?",
  prediction: {
    options: [
      { id: "storage", label: "The storage volume has to be rebuilt from a snapshot." },
      { id: "capacity", label: "The cluster starts at its floor and must resume or scale while requests queue." },
      { id: "network", label: "Cross-AZ replication is paused after idle." },
      { id: "backup", label: "The automated backup window overlaps the morning traffic." },
    ],
    correctOptionId: "capacity",
    explanation:
      "A low minimum leaves the cluster at its floor when traffic returns. The first requests arrive before capacity has scaled, so they queue; a cold pool adds connection setup on top. Storage is not rebuilt and replication is not the dominant term in this model. The fix is to raise the floor, warm the pool, and pre-scale before known ramps.",
  },
  setup: defaults({ peakAcu: 256, minAcu: 0.5, idleMinutes: 60, poolSize: 5, scaleAcuPerSecond: 0.5 }),
  runFor: 60,
  observe: [
    "Capacity starts at 0.5 ACU and reaches about 30 ACU after a minute, while demand is 256 ACU.",
    "The capacity deficit is above 80% and the p99 threshold is critical.",
    "The resume penalty and a cold pool add latency even before the queue clears.",
    "The storage node stays healthy; the failure is compute capacity and client warmth.",
  ],
  explain:
    "Serverless capacity is not instantly equal to demand. The cluster holds a floor, then adds ACUs at a finite rate. If the workload arrives faster than that rate, requests wait. A low floor saves money at idle and costs latency at the start of the ramp. The right floor depends on the idle pattern and the latency budget, not on the average utilization.",
  fix: defaults({ peakAcu: 64, minAcu: 16, idleMinutes: 60, poolSize: 80, scaleAcuPerSecond: 4 }),
  debrief:
    "With a 16 ACU floor and a warm pool, a 64 ACU peak is served after about 12 seconds and p99 stays inside the warning band. The cluster is never fully cold, but it pays for 16 ACU while idle. That is the trade: a capacity floor buys latency insurance and shows up on the bill every hour.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Aurora Serverless scales database compute in Aurora capacity units (ACUs). An ACU bundles a measured amount of memory, CPU, and network, and the cluster adds or removes ACUs as the workload changes. You set a minimum and a maximum; the service moves between them. Storage is separate and does not scale with the ACU value.",
  },
  {
    type: "p",
    text: "Capacity is not instantaneous. A cluster that has been idle at a low floor has to resume or scale up before it can serve a burst. Aurora Serverless v1 could pause entirely and needed a resume; Serverless v2 scales in smaller increments and keeps a configurable floor, but it still starts below a sudden peak. The first requests queue while capacity catches up, and a cold connection pool adds setup work at the same time.",
  },
  {
    type: "p",
    text: "The design question is the floor. A low minimum is cheap at idle and expensive at the start of a ramp. A high minimum is billed continuously but keeps capacity resident. The right answer depends on how long the cluster is idle, how fast traffic returns, and how much latency the first requests can tolerate.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application pool connects to the cluster endpoint. The cluster's capacity control loop watches load and adjusts ACUs between the minimum and maximum. Storage is shared and durable; the writer and readers use it. When capacity changes, connections may stay open, but new compute has to warm caches and accept work. A pool that was closed during idle makes the first requests pay connection setup as well.",
  },
  {
    type: "table",
    headers: ["Lever", "What it changes", "Cost"],
    rows: [
      ["Minimum ACU", "Capacity kept resident while idle", "Paid every hour at the floor"],
      ["Maximum ACU", "Ceiling for a peak", "Only paid when used"],
      ["Scale-up rate", "How fast capacity follows demand", "Depends on workload and engine behavior"],
      ["Pool warmth", "Connection setup on first requests", "Idle connections and memory"],
      ["Ramp shape", "How quickly demand arrives", "Admission control or queueing"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request p99: warning at 100 ms and critical at 500 ms in this model.",
      "Capacity deficit: current demand minus available ACUs, warning at 20% and critical at 50%.",
      "Current capacity in ACUs against peak demand.",
      "Resume penalty: the extra delay when the cluster was cold.",
      "Warm pool connections, which change the first-request cost without changing ACU capacity.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Cold resume. Read the capacity deficit before the p99. Raise the minimum capacity and the pool size separately to see which one removes the timeout. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "ACU sizes, scale rates, and latency values are illustrative teaching numbers. Real scaling depends on the engine version, the workload's memory and CPU shape, the cluster's control loop, and the connections in flight. Treat the model as a shape for reasoning, not a sizing calculator.",
  },
  { type: "sim", simId: "aurora-serverless" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The cluster sat at 0.5 ACU overnight. The morning ramp needed 256 ACU, but capacity grew at half an ACU per second, so after a minute it was still around 30 ACU. Requests queued behind the deficit, the resume penalty applied to the first arrivals, and the pool had only five warm connections. The result was a p99 well past the request timeout while storage stayed healthy.",
  },
  {
    type: "p",
    text: "Raising the floor to 16 ACU and warming the pool changed the shape of the ramp. A 64 ACU peak was served in about 12 seconds, and p99 stayed under 100 ms. The cluster was never fully cold. The cost is continuous billing at the floor, which is the trade the floor is meant to buy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Aurora Serverless capacity metrics: ACU utilization, ACU capacity, and the difference between demand and available capacity.",
      "Database latency and connection counts around the start of the ramp, not just the daily average.",
      "Application pool metrics: active, idle, waiting, and connection creation time.",
      "Engine logs for resume, scaling, and authentication events at the start of the burst.",
      "Queue depth or admission-control drops if the application has a waiting layer.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare capacity with demand at the moment of the latency spike. If the cluster was idle below the demand and the deficit is large, the fix is a floor or a slower ramp, not a bigger maximum. If capacity is already at demand, check the pool, the query plan, and storage I/O instead.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the idle pattern and the time from first request to full capacity.",
      "Set the minimum ACU from the latency budget and the expected ramp, not from average utilization.",
      "Keep a warm pool or pre-open connections before the known peak.",
      "Pre-scale or schedule capacity changes ahead of predictable batch or morning traffic.",
      "Add admission control or queueing so a cold start degrades gracefully instead of timing out.",
      "Re-evaluate the floor after the traffic pattern changes; a floor sized for last quarter can be wrong.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher floor reduces cold-start latency and increases the idle bill every hour.",
      "A higher maximum protects the peak but does not help if scale-up starts too late.",
      "A larger warm pool reduces first-request latency and holds idle connections and memory.",
      "Pre-scaling ahead of a peak costs capacity before it is needed; reacting after the peak costs latency.",
      "Admission control protects the cluster but rejects or queues work the product may consider essential.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cold-start",
    question: "A serverless database is slow every morning after an idle night. How do you explain it?",
    difficulty: 2,
    hints: [
      "Capacity has a floor and a ramp.",
      "Storage is not the thing that resumes.",
    ],
    answer:
      "The cluster is at its minimum capacity when the first requests arrive. It has to resume or scale toward demand, and scale-up takes time, so early requests queue. A cold connection pool adds setup and authentication on top. I would compare ACU capacity with demand at the spike, check the minimum and the scale-up behavior, then raise the floor, warm the pool, or pre-scale before the known ramp. Storage is durable and is not rebuilt for a compute resume.",
    followUps: [
      "How would you choose the new floor?",
      "What does the floor cost while idle?",
      "How would admission control change the experience?",
    ],
    redFlags: [
      "Blames storage or backups.",
      "Raises the maximum only.",
      "Ignores the connection pool.",
    ],
    rubric: [
      "Explains the floor and the ramp.",
      "Separates compute from storage.",
      "Checks the pool.",
      "Chooses a floor or pre-scale.",
    ],
  },
  {
    id: "set-floor",
    question: "How do you set the minimum ACU for a workload with a daily peak and a long idle window?",
    difficulty: 3,
    hints: [
      "Start from the latency budget at the ramp.",
      "Compare the idle bill with the cost of missing the SLO.",
    ],
    answer:
      "I would measure the idle window, the ramp rate, and the latency budget for the first requests. Then I would estimate the capacity needed at the start of the ramp and set the floor so the cluster does not begin from zero, checking the cost of that floor over the idle hours. If the floor is too expensive, I would combine a lower floor with pre-scaling before the known peak or admission control during the first minute. The floor is an availability decision with a visible hourly price.",
    followUps: [
      "What if the peak time moves?",
      "How would you validate the setting?",
      "When would a provisioned cluster be cheaper?",
    ],
    redFlags: [
      "Uses average utilization only.",
      "Ignores the idle bill.",
      "Assumes scaling is instant.",
    ],
    rubric: [
      "Uses the ramp and latency budget.",
      "Quantifies the idle cost.",
      "Considers pre-scaling or admission control.",
      "Plans validation.",
    ],
  },
  {
    id: "serverless-limits",
    question: "When would you not choose Aurora Serverless for a database?",
    difficulty: 3,
    hints: [
      "Think about steady high load and latency sensitivity.",
      "Think about features and control.",
    ],
    answer:
      "I would avoid it when the workload is steadily high and predictable, because a provisioned instance can be cheaper and its capacity is not tied to a scaling control loop. I would also be careful with latency-sensitive workloads that cannot tolerate a cold ramp, workloads that need instance-level control or extensions that serverless does not support, and systems where the connection pattern creates a large cold pool. Serverless is strongest when demand is spiky or unpredictable and the floor can be justified.",
    followUps: [
      "How would you compare the costs?",
      "What does a steady workload gain from provisioning?",
      "Which failure mode would you test first?",
    ],
    redFlags: [
      "Chooses serverless for every workload.",
      "Ignores cold-start latency.",
      "Assumes unlimited scaling.",
    ],
    rubric: [
      "Names steady-load cost.",
      "Names cold-start latency.",
      "Considers feature or control limits.",
      "Matches the choice to the demand shape.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The idle pattern and morning ramp are measured, not assumed.",
      "The minimum ACU is justified by a latency budget.",
      "The connection pool has a warm-up path before known peaks.",
      "Capacity and demand are charted together, not capacity alone.",
      "A pre-scale or admission-control option exists for predictable spikes.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare current ACU capacity with demand at the spike.",
      "Check whether the cluster was cold or merely slow to scale.",
      "Check pool creation time and waiting connections.",
      "Protect the database with queueing or load shedding while capacity catches up.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Adjust the floor, pool, or ramp based on the measured gap.",
      "Re-test the morning path with a production-like burst.",
      "Record the cost of the new floor.",
      "Update the runbook for a cold resume and a scale-up lag.",
    ],
  },
];

const references = [
  {
    title: "Amazon Aurora Serverless v2",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Capacity units, minimum and maximum capacity, and how Serverless v2 scales.",
  },
  {
    title: "How Aurora Serverless v2 works",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-how-it-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Scaling behavior, capacity units, and the difference between capacity and demand.",
  },
  {
    title: "Amazon CloudWatch metrics for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ACU utilization and capacity metrics to compare with application latency.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "aurora-serverless": {
      model: serverlessModel,
      presets,
      instructions:
        "Start healthy, apply Cold resume, and read the capacity deficit before the p99. Raise the minimum capacity and the pool size separately. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. ACU sizes, scale rates, and latency values are teaching values, not Aurora sizing guidance.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-max-connections",
    "foundations-capacity-headroom",
    "foundations-queueing-knee",
  ],
};
