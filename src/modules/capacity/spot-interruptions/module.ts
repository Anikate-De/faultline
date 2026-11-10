import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WORKERS = 20;
const LOSS_PER_WORKER = 8;
const REPLACE_FALLBACK_SECONDS = 15;
const REPLACE_SPOT_SECONDS = 45;
const MAX_WORKERS = 24;

const params = [
  {
    id: "spotSharePct",
    label: "Spot share",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Fleet",
    help: "Share of the 20-worker fleet that runs on Spot at the start. The rest is on-demand.",
    format: "percent" as const,
  },
  {
    id: "interruptionsPerHour",
    label: "Interruption rate",
    min: 0,
    max: 12,
    step: 1,
    value: 2,
    unit: "/hour",
    group: "Spot",
    help: "Spot interruptions per simulated hour. The model compresses one hour into 60 seconds.",
    format: "number" as const,
  },
  {
    id: "drainSeconds",
    label: "Drain and checkpoint",
    min: 0,
    max: 300,
    step: 30,
    value: 120,
    unit: "s",
    group: "Workload",
    help: "Time available to finish in-flight work before an interrupted worker leaves. Longer drain and checkpoint windows lose less work.",
    format: "number" as const,
  },
  {
    id: "fallbackOn",
    label: "On-demand fallback",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Fleet",
    help: "1 replaces interrupted Spot workers with on-demand capacity after 15s. 0 waits for Spot replacement after 45s.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function intervalFor(p: Params): number {
  const rate = Math.max(0, num(p, "interruptionsPerHour", 2));
  return rate <= 0 ? 1_000 : 60 / rate;
}

function initialFleet(p: Params): { spot: number; od: number } {
  const share = clamp(num(p, "spotSharePct", 60), 0, 100);
  const spot = Math.round((WORKERS * share) / 100);
  return { spot, od: WORKERS - spot };
}

interface Computed {
  spot: number;
  od: number;
  capacity: number;
  completion: number;
  spotShare: number;
  lostWork: number;
  backlog: number;
  interruptions: number;
}

function compute(
  spot: number,
  od: number,
  lostWork: number,
  interruptions: number,
): Computed {
  const safeSpot = Math.max(0, spot);
  const safeOd = Math.max(0, od);
  const capacity = Math.min(MAX_WORKERS, safeSpot + safeOd);
  const completion = Math.min(100, (capacity / WORKERS) * 100);
  return {
    spot: safeSpot,
    od: safeOd,
    capacity,
    completion,
    spotShare: capacity > 0 ? (safeSpot / capacity) * 100 : 0,
    lostWork: Math.max(0, lostWork),
    backlog: Math.max(0, WORKERS - capacity) * 10,
    interruptions,
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  const shortfall = 100 - values.completion;
  const deficit = WORKERS - values.capacity;
  if (shortfall >= 25 || values.lostWork >= 50 || deficit >= 10) return "crit";
  if (shortfall >= 10 || values.lostWork >= 20 || deficit >= 4) return "warn";
  return "ok";
}

function lostHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.lostWork >= 50) return "crit";
  if (values.lostWork >= 20) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["completion", values.completion, 0.5],
    ["lost-work", values.lostWork, 0.2],
    ["fleet-capacity", values.capacity, 0.1],
    ["spot-share", values.spotShare, 0.5],
    ["interruptions", values.interruptions, 0.1],
    ["backlog", values.backlog, 1],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.99 + 0.01 * Math.sin((index + (seed % 8)) / 2.7)) + amplitude * Math.sin(index / 2.3)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  values: Computed,
  state: { firstInterruption: boolean; noFallback: boolean; replacementLag: boolean },
): SimFrame {
  const health = serviceHealth(values);
  const fallbackOn = num(p, "fallbackOn", 1) >= 0.5;
  const fallbackHealth: "ok" | "warn" | "crit" = fallbackOn || health === "ok"
    ? "ok"
    : health === "crit" && values.capacity <= 16
      ? "crit"
      : "warn";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Job submitter",
        kind: "client",
        health: "ok",
        sublabel: "batch jobs",
        meta: { view: "flow" },
      },
      {
        id: "scheduler",
        label: "Batch scheduler",
        kind: "service",
        health: "ok",
        utilization: clamp(values.capacity / WORKERS),
        sublabel: `${Math.round(values.capacity)} of ${WORKERS} workers`,
        detail: "The scheduler places work on whatever workers are available. It does not decide whether a worker is interruptible.",
        meta: { view: "flow" },
      },
      {
        id: "spot",
        label: "Spot fleet",
        kind: "worker",
        health,
        utilization: clamp(values.spot / Math.max(1, values.capacity)),
        sublabel: `${values.spot} Spot · ${Math.round(values.spotShare)}% of fleet`,
        detail: "Spot capacity can be reclaimed with a short interruption notice. The notice is a deadline for checkpointing and draining, not a guarantee of replacement capacity.",
        meta: { view: "flow" },
      },
      {
        id: "fallback",
        label: fallbackOn ? "On-demand fallback" : "No fallback",
        kind: "worker",
        health: fallbackHealth,
        utilization: clamp(values.od / Math.max(1, values.capacity)),
        sublabel: fallbackOn
          ? `${values.od} on-demand · 15s replace`
          : `${values.od} on-demand · waits for Spot`,
        detail: fallbackOn
          ? "On-demand workers replace interrupted Spot capacity after a short launch delay. They cost more per hour and keep completion stable."
          : "Without a fallback, interrupted capacity is replaced only by another Spot launch. The fleet runs below target until that succeeds.",
        meta: { view: "flow" },
      },
      {
        id: "results",
        label: "Checkpoint store",
        kind: "storage",
        health: lostHealth(values),
        utilization: clamp(values.lostWork / 100),
        sublabel: `${Math.round(values.lostWork)} job-units lost · ${values.interruptions} interruptions`,
        detail: "Checkpoint frequency and drain time determine how much work is lost when a worker is reclaimed.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-scheduler", "client", "scheduler", 0.8, "ok"),
      edge("scheduler-spot", "scheduler", "spot", clamp(values.spot / WORKERS), health),
      edge("spot-fallback", "spot", "fallback", clamp(values.od / WORKERS), fallbackHealth),
      edge("fallback-results", "fallback", "results", clamp(values.capacity / WORKERS), lostHealth(values)),
    ],
    metrics: [
      metric("completion", "Completion", values.completion, "%", undefined, undefined, "percent"),
      metric("completion-shortfall", "Completion shortfall", 100 - values.completion, "%", 10, 25, "percent"),
      metric("lost-work", "Lost work", values.lostWork, " job-units", 20, 50, "number"),
      metric("fleet-capacity", "Fleet capacity", values.capacity, " workers", undefined, undefined, "count"),
      metric("capacity-deficit", "Capacity deficit", WORKERS - values.capacity, " workers", 4, 10, "count"),
      metric("spot-share", "Actual Spot share", values.spotShare, "%", undefined, undefined, "percent"),
      metric("interruptions", "Interruptions", values.interruptions, " events", undefined, undefined, "count"),
      metric("backlog", "Backlog", values.backlog, " job-units", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      firstInterruption: state.firstInterruption ? 1 : 0,
      noFallback: state.noFallback ? 1 : 0,
      replacementLag: state.replacementLag ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.capacity)} of ${WORKERS} workers are serving; completion is ${Math.round(values.completion)}%. ${values.interruptions} interruptions have lost ${Math.round(values.lostWork)} job-units.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const fleet = initialFleet(p);
  const values = compute(fleet.spot, fleet.od, 0, 0);
  const frame = buildFrame(p, seed, values, {
    firstInterruption: false,
    noFallback: false,
    replacementLag: false,
  });
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "completion",
    metricId: "completion-shortfall",
    warn: 10,
    crit: 25,
    title: "The batch workload is missing its completion target",
    cause:
      "Interrupted capacity was removed faster than replacement capacity arrived. Without checkpointing, drain time, and a fallback, each interruption also loses the work that was in flight.",
    fix:
      "Add checkpointing and a drain window, keep a baseline of on-demand or diversified capacity, and use a fallback when Spot capacity cannot be replaced quickly. Reduce Spot share for latency-sensitive work.",
    checkFirst: [
      "Check the number of workers removed and when replacements arrived.",
      "Check whether the workload checkpointed before the interruption notice expired.",
      "Check whether the fallback is enabled and whether it has launch capacity.",
    ],
  },
  {
    id: "lost-work",
    metricId: "lost-work",
    warn: 20,
    crit: 50,
    title: "Interruptions are destroying completed work",
    cause:
      "Work since the last checkpoint is lost when a worker is reclaimed. A short drain window or a long checkpoint interval increases the loss per interruption.",
    fix:
      "Checkpoint more often, drain before termination, and move long-running units to on-demand capacity. Make the job idempotent so a retry does not duplicate side effects.",
    checkFirst: [
      "Compare the checkpoint interval with the interruption notice window.",
      "Check whether the drain hook ran and how long it had.",
      "Check whether jobs are retried or restarted from the beginning.",
    ],
  },
  {
    id: "fleet-capacity",
    metricId: "capacity-deficit",
    warn: 4,
    crit: 10,
    title: "The fleet is below the capacity the workload needs",
    cause:
      "Spot interruptions removed workers and replacements were slow or absent. The scheduler keeps placing work on a fleet that can no longer process it at the target rate.",
    fix:
      "Add a fallback path, diversify instance types and Availability Zones, or reduce the Spot share. Do not rely on a single replacement path during a regional capacity event.",
    checkFirst: [
      "Check the replacement queue and the launch times for Spot and on-demand.",
      "Check whether the fallback has capacity in every zone.",
      "Check whether other workloads are competing for the same instance types.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const spotInterruptionsModel: SimModel = {
  id: "capacity-spot-interruptions",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    const fleet = initialFleet(p);
    let spot = fresh ? fleet.spot : Number(frame.flags.spot ?? fleet.spot);
    let od = fresh ? fleet.od : Number(frame.flags.od ?? fleet.od);
    let replacementQueue = fresh ? 0 : Number(frame.flags.replacementQueue ?? 0);
    let lostWork = fresh ? 0 : Number(frame.flags.lostWork ?? 0);
    let interruptions = fresh ? 0 : Number(frame.flags.interruptions ?? 0);
    let nextInterrupt = fresh ? intervalFor(p) : Number(frame.flags.nextInterrupt ?? intervalFor(p));
    const fallbackOn = num(p, "fallbackOn", 1) >= 0.5;
    const initialReplace = intervalFor(p) + (fallbackOn ? REPLACE_FALLBACK_SECONDS : REPLACE_SPOT_SECONDS);
    let nextReplace = fresh ? initialReplace : Number(frame.flags.nextReplace ?? initialReplace);
    if (![spot, od, replacementQueue, lostWork, interruptions, nextInterrupt, nextReplace].every(Number.isFinite)) {
      spot = fleet.spot;
      od = fleet.od;
      replacementQueue = 0;
      lostWork = 0;
      interruptions = 0;
      nextInterrupt = intervalFor(p);
      nextReplace = initialReplace;
    }
    let firstInterruption = fresh ? false : frame.flags.firstInterruption === 1;
    let noFallback = fresh ? false : frame.flags.noFallback === 1;
    let replacementLag = fresh ? false : frame.flags.replacementLag === 1;

    const rate = Math.max(0, num(p, "interruptionsPerHour", 2));
    if (rate > 0 && t >= nextInterrupt) {
      const remove = Math.min(spot, Math.max(1, Math.round(spot * 0.1)));
      if (replacementQueue === 0) {
        nextReplace = t + (fallbackOn ? REPLACE_FALLBACK_SECONDS : REPLACE_SPOT_SECONDS);
      }
      spot -= remove;
      replacementQueue += remove;
      const drainFactor = clamp(num(p, "drainSeconds", 120) / 180);
      lostWork += remove * (1 - drainFactor) * LOSS_PER_WORKER;
      interruptions += 1;
      nextInterrupt = t + intervalFor(p);
    }

    if (replacementQueue > 0 && t >= nextReplace) {
      if (fallbackOn) od += 1;
      else spot += 1;
      replacementQueue -= 1;
      nextReplace = t + (fallbackOn ? REPLACE_FALLBACK_SECONDS : REPLACE_SPOT_SECONDS);
    }

    spot = clamp(spot, 0, MAX_WORKERS);
    od = clamp(od, 0, MAX_WORKERS);
    if (spot + od > MAX_WORKERS) od = Math.max(0, MAX_WORKERS - spot);
    const values = compute(spot, od, lostWork, interruptions);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values, {
      firstInterruption,
      noFallback,
      replacementLag,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!firstInterruption && values.interruptions > 0) {
      pushEvent(next, {
        id: "spot-interruption",
        at: t,
        severity: values.completion < 90 ? "warn" : "info",
        title: "Spot capacity was reclaimed",
        detail: `The fleet lost workers and now has ${Math.round(values.capacity)} of ${WORKERS} serving. Replacement is ${fallbackOn ? "on-demand" : "Spot-only"}.`,
        nodeId: "spot",
        metricId: "fleet-capacity",
      });
      firstInterruption = true;
    }

    if (!noFallback && !fallbackOn && values.capacity <= 16) {
      pushEvent(next, {
        id: "no-fallback",
        at: t,
        severity: "crit",
        title: "Interrupted capacity has no fallback",
        detail: `Capacity is ${Math.round(values.capacity)} workers and the replacement queue is ${Math.round(replacementQueue)}. With no on-demand fallback, completion stays below target until Spot capacity returns.`,
        nodeId: "fallback",
        metricId: "completion",
      });
      noFallback = true;
    }

    if (!replacementLag && replacementQueue > 0 && !fallbackOn) {
      pushEvent(next, {
        id: "replacement-lag",
        at: t,
        severity: "warn",
        title: "Replacement is queued behind Spot launch time",
        detail: `${Math.round(replacementQueue)} workers are waiting for Spot replacement. Each launch takes about ${REPLACE_SPOT_SECONDS}s before it can serve.`,
        nodeId: "fallback",
        metricId: "fleet-capacity",
      });
      replacementLag = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      spot,
      od,
      replacementQueue,
      lostWork,
      interruptions,
      nextInterrupt,
      nextReplace,
      firstInterruption: firstInterruption ? 1 : 0,
      noFallback: noFallback ? 1 : 0,
      replacementLag: replacementLag ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `${Math.round(value("fleet-capacity"))} of ${WORKERS} workers are serving, completion is ${Math.round(value("completion"))}%, and ${Math.round(value("lost-work"))} job-units are lost.`,
      `${value("interruptions")} interruptions have occurred. The loss per interruption depends on the checkpoint interval and the drain window.`,
      "Spot is a capacity source, not an availability guarantee. The workload needs a way to checkpoint, drain, and continue on another worker.",
    ];
    if (value("completion") < 90) {
      items.push("Completion is below target: check whether the fleet lost capacity faster than the fallback could replace it.");
    }
    if (value("lost-work") >= 20) {
      items.push("Lost work is accumulating: shorten the checkpoint interval or drain before termination.");
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
    description: "60% Spot, a low interruption rate, a long drain window, and on-demand fallback keep completion at target.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak interruption rate",
    description: "80% Spot and four interruptions per hour; the fallback keeps the fleet near target but not quite.",
    tone: "warn",
    params: defaults({ spotSharePct: 80, interruptionsPerHour: 4, drainSeconds: 90, fallbackOn: 1 }),
  },
  {
    id: "failure",
    label: "No fallback",
    description: "100% Spot, twelve interruptions per hour, a short drain, and no on-demand replacement.",
    tone: "crit",
    params: defaults({ spotSharePct: 100, interruptionsPerHour: 12, drainSeconds: 30, fallbackOn: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Half Spot, two interruptions per hour, a full drain window, and on-demand fallback.",
    tone: "ok",
    params: defaults({ spotSharePct: 50, interruptionsPerHour: 2, drainSeconds: 180, fallbackOn: 1 }),
  },
  {
    id: "spot-only",
    label: "Spot only, slow replacement",
    description: "100% Spot with a fallback off but a low interruption rate; completion dips and recovers between events.",
    tone: "warn",
    params: defaults({ spotSharePct: 100, interruptionsPerHour: 2, drainSeconds: 180, fallbackOn: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-fallback",
  title: "Predict what keeps completion stable",
  simId: "spot-interruptions",
  question:
    "The fleet is 100% Spot, interruptions arrive twelve times per hour, and there is no on-demand fallback. Which change protects completion without abandoning Spot entirely?",
  prediction: {
    options: [
      { id: "drain", label: "Increase the drain window only" },
      { id: "fallback", label: "Add on-demand fallback capacity and keep some Spot" },
      { id: "jobs", label: "Make each job run longer so there are fewer jobs" },
      { id: "share", label: "Raise the Spot share to 100% and retry failed jobs" },
    ],
    correctOptionId: "fallback",
    explanation:
      "A drain window reduces lost work per interruption, but it does not replace the capacity that was reclaimed. Longer jobs increase the exposure per interruption. Retrying on the same Spot-only fleet does not create capacity. A baseline of on-demand capacity and a fallback path keep the fleet at its completion target while Spot absorbs the cheap, interruptible part of the workload.",
  },
  setup: defaults({ spotSharePct: 100, interruptionsPerHour: 12, drainSeconds: 30, fallbackOn: 0 }),
  runFor: 45,
  observe: [
    "Spot workers are reclaimed every five simulated seconds.",
    "The replacement queue grows faster than Spot launches can refill it.",
    "Completion falls below half of the target and lost work climbs past the critical threshold.",
    "The fallback is off, so there is no second path to capacity.",
  ],
  explain:
    "Spot interruptions are capacity events, not application failures. The workload needs enough checkpoint and drain behavior to survive one event, and enough replacement capacity to survive a burst. On-demand fallback is the simplest second path; diversified Spot capacity and capacity-optimized allocation reduce the chance that all replacements fail together.",
  fix: defaults({ spotSharePct: 50, interruptionsPerHour: 2, drainSeconds: 180, fallbackOn: 1 }),
  debrief:
    "Half the fleet stays on Spot, the drain window covers in-flight work, and on-demand workers replace the interrupted capacity after a short launch delay. Completion stays at target, and the Spot share still captures most of the discount. The trade is paying the on-demand rate for the fallback and holding a little more headroom.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Spot capacity is spare cloud capacity sold at a discount. The trade is that the provider can reclaim it. AWS sends a two-minute interruption notice before reclaiming a Spot Instance, and the notice can be observed through the instance metadata service and EventBridge. Two minutes is enough to checkpoint and drain a well-behaved task; it is not enough to finish an arbitrary long-running job. That deadline is the design constraint.",
  },
  {
    type: "p",
    text: "The workload has to tolerate losing a worker. Stateless request handlers tolerate it if another worker can take the next request. Batch jobs tolerate it if they checkpoint and resume, or if they can restart from the beginning cheaply. A job that holds hours of uncommitted state in memory does not tolerate it. The question is not whether Spot is cheaper; it is whether the work can be interrupted without losing more value than the discount provides.",
  },
  {
    type: "p",
    text: "Spot interruptions are also correlated. A single instance type or Availability Zone can become scarce, so a fleet that draws all its Spot capacity from one pool can lose most of it at once. Diversifying instance types and zones, using capacity-optimized allocation, and keeping an on-demand baseline reduces the chance that one event removes the whole fleet. The fallback is not free, but it is the difference between a capacity dip and a stalled workload.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The Spot fleet sits behind the scheduler and beside the checkpoint store. The scheduler places work; the checkpoint store holds progress; the fallback provides capacity when Spot is reclaimed. The queue is the buffer that absorbs a short capacity dip. If the queue is unbounded and the workload is latency-sensitive, Spot is the wrong tool regardless of the discount.",
  },
  {
    type: "table",
    headers: ["Workload", "Checkpoint", "Drain", "Spot fit"],
    rows: [
      ["Stateless request handler", "None needed", "Stop accepting new requests", "Good with diversified capacity"],
      ["Batch job with checkpoints", "Every few minutes", "Finish the current unit", "Good with a fallback"],
      ["Long single-shot job", "None", "Cannot finish in the notice", "Poor unless it can restart cheaply"],
      ["Stateful stream processor", "Offset commit", "Flush and commit", "Good with a short commit interval"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 20-worker fleet, a 60-second simulated hour, and a 15-second on-demand replacement versus a 45-second Spot replacement. The interruption rate is a teaching input, not a prediction of any particular Spot pool. The loss per interruption depends on the drain window and is measured in job-units, not currency. Those are illustrative values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Completion, the share of the 20-worker target that is actually serving.",
      "Fleet capacity and the replacement queue behind it.",
      "Lost work in job-units, which grows when interruptions outrun checkpointing.",
      "Actual Spot share, which changes as replacements arrive.",
      "Interruption count and backlog, so capacity loss and work waiting are separate.",
      "A flow from job submitter to scheduler to Spot fleet to fallback to checkpoint store.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply No fallback. Watch the Spot fleet shrink and the replacement queue grow. Run the guided experiment before changing sliders. Compare Peak interruption rate with Recovery: the difference is not only the Spot share, but the drain window and the second path to capacity.",
  },
  { type: "sim", simId: "spot-interruptions" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet started with all 20 workers on Spot. Interruptions arrived every five simulated seconds, and each one removed about two workers. The replacement queue grew because the only path back was another Spot launch, which took 45 seconds. The fleet fell below half its target by the end of the run, completion dropped under 50%, and lost work passed the critical threshold. The scheduler kept accepting jobs into a fleet that could not process them.",
  },
  {
    type: "p",
    text: "In Recovery, half the fleet stayed on Spot and the other half was on-demand. Interruptions were rarer, the drain window covered in-flight work, and the fallback replaced lost capacity after 15 seconds. Completion stayed at target. The Spot share still captured most of the discount without putting the completion target at risk.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "EC2 Spot request status and the interruption notice timestamp from instance metadata or EventBridge.",
      "Fleet capacity by instance type and Availability Zone, not only the total.",
      "Checkpoint age and the number of jobs restarted from the beginning.",
      "Batch completion rate, queue age, and the number of jobs waiting for a worker.",
      "On-demand fallback launches and their time-to-serve during the same window.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether capacity was lost and whether replacement arrived. Then check the checkpoint and drain window: a fallback restores capacity, but it does not recover work that was never checkpointed. Finally, check whether the lost capacity was concentrated in one instance type or zone.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the workload can checkpoint and resume, or move the sensitive stage to on-demand capacity.",
      "Set the checkpoint interval inside the interruption notice window and test the drain path.",
      "Keep an on-demand baseline or fallback for the capacity that cannot wait for a Spot replacement.",
      "Diversify instance types and Availability Zones and use capacity-optimized allocation.",
      "Bound the queue and shed or defer work when capacity is below the target.",
      "Test with several interruptions in a row, not one at a time.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher Spot share lowers cost and raises the chance that one capacity event removes most of the fleet.",
      "An on-demand fallback protects completion and gives up part of the discount.",
      "Frequent checkpoints reduce lost work and add I/O and storage cost.",
      "A longer drain window loses less work per interruption and holds a worker longer before it leaves.",
      "Diversified Spot capacity reduces correlated loss and can be harder to place at the lowest price.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "spot-fit",
    question:
      "How do you decide whether a workload can run on Spot?",
    difficulty: 2,
    hints: [
      "Start from what happens when a worker disappears without warning beyond the notice.",
      "The discount does not matter if the work cannot resume.",
    ],
    answer:
      "I would look at the unit of work and the cost of losing it. If the work is stateless or can checkpoint and resume inside the interruption notice, Spot is a good fit. If it holds hours of uncommitted state, cannot drain, or has a hard completion deadline, it needs on-demand capacity or a redesign. I would also check whether the fleet can diversify across instance types and zones, and whether a fallback exists for the capacity that cannot wait.",
    followUps: [
      "What is the role of the two-minute notice?",
      "How would you test the drain path?",
      "When would you keep a workload on on-demand?",
    ],
    redFlags: [
      "Says Spot is safe because it is cheaper.",
      "Ignores checkpoint and drain.",
      "Assumes replacement capacity is always available.",
    ],
    rubric: [
      "Starts from interruption tolerance.",
      "Mentions checkpoint and drain.",
      "Considers fallback and diversity.",
      "States the completion risk.",
    ],
  },
  {
    id: "interruption-burst",
    question:
      "Several Spot workers are reclaimed at once and completion drops. What do you check first?",
    difficulty: 3,
    hints: [
      "Separate capacity loss from work loss.",
      "Check whether the lost workers were concentrated in one pool.",
    ],
    answer:
      "I would check the fleet capacity by instance type and zone, the replacement queue, and the fallback launch time. If the losses are concentrated, the fleet lacks diversity. If the replacement queue is long, the fallback is too small or too slow. Then I would check checkpoint age and how many jobs restarted from the beginning. Capacity recovery and work recovery are different problems: the fallback fixes the first, checkpointing fixes the second.",
    followUps: [
      "How would you measure correlated interruption risk?",
      "What would you change in the scheduler?",
      "How do you avoid retry amplification?",
    ],
    redFlags: [
      "Looks only at the total worker count.",
      "Adds retries without a cap.",
      "Ignores the checkpoint path.",
    ],
    rubric: [
      "Separates capacity from lost work.",
      "Checks diversity and replacement.",
      "Checks checkpoint age.",
      "Bounds retries.",
    ],
  },
  {
    id: "fallback-cost",
    question:
      "How would you justify the cost of an on-demand fallback for a Spot fleet?",
    difficulty: 3,
    hints: [
      "Compare the fallback cost with the cost of missed completion.",
      "The fallback does not have to cover the whole fleet.",
    ],
    answer:
      "I would size the fallback to the capacity that must survive a burst, not to the whole fleet. Then I would compare its cost with the completion loss and retry cost of the last interruption event. A small on-demand baseline that covers the critical stage is often cheaper than losing a batch window. I would also test whether diversified Spot capacity or a different instance type reduces the need for the fallback before paying for a permanent one.",
    followUps: [
      "How large should the fallback be?",
      "What is the cost of a missed batch window?",
      "Would you use a different capacity source instead?",
    ],
    redFlags: [
      "Sizes the fallback to the entire peak.",
      "Treats the fallback as free.",
      "Has no completion target to compare against.",
    ],
    rubric: [
      "Sizes to the critical capacity.",
      "Compares with outage cost.",
      "Considers diversity first.",
      "States the residual risk.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every Spot workload has a documented checkpoint interval and drain path.",
      "The interruption notice is handled automatically, not by an on-call runbook.",
      "The fleet is diversified across instance types and Availability Zones.",
      "An on-demand baseline or fallback covers the work that cannot wait.",
      "The queue is bounded and the scheduler can defer work when capacity is short.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check capacity by instance type and zone, not only the total.",
      "Check the replacement queue and the fallback launch time.",
      "Check checkpoint age and the number of jobs restarted.",
      "Reduce admission or defer low-priority work if completion is at risk.",
      "Record interruption timestamps and the capacity lost per event.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-test with several interruptions in a row.",
      "Adjust the Spot share, fallback size, or checkpoint interval.",
      "Add diversity or capacity-optimized allocation if losses were correlated.",
      "Document the completion and cost tradeoff for the next review.",
    ],
  },
];

const references = [
  {
    title: "Spot Instance interruptions",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-interruptions.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Spot Instances can be interrupted with a two-minute notice; the notice can be handled through metadata and EventBridge.",
  },
  {
    title: "Best practices for Amazon EC2 Spot",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-best-practices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Diversify instance types and zones, use capacity-optimized allocation, and design for interruption.",
  },
  {
    title: "Spot Instances",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/using-spot-instances.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Spot capacity is spare EC2 capacity offered at a discount and can be reclaimed.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "spot-interruptions": {
      model: spotInterruptionsModel,
      presets,
      instructions:
        "Start healthy, apply No fallback, then compare Peak interruption rate and Recovery. Watch completion, fleet capacity, and lost work together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Interruption rates and replacement times are teaching values, not AWS capacity predictions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-fargate-spot",
    "capacity-warm-pools",
    "capacity-headroom-cost",
    "foundations-retry-backoff-jitter",
  ],
};
