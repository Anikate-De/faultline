import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MEMORY_LINES_PER_MB = 2_000;
const DISK_LINES_PER_MB = 2_000;
const ERROR_SHARE = 0.01;
const WARN_SHARE = 0.04;
const INFO_SHARE = 0.25;
const DEBUG_SHARE = 0.7;
const PROTECTED_SHARE = ERROR_SHARE + WARN_SHARE;

const params = [
  {
    id: "logRate",
    label: "Log ingest",
    min: 5_000,
    max: 120_000,
    step: 1_000,
    value: 20_000,
    unit: " lines/s",
    group: "Traffic",
    help: "Log lines per second produced by the application fleet before the agent buffers them.",
    format: "rps" as const,
  },
  {
    id: "bufferMb",
    label: "Memory buffer",
    min: 8,
    max: 512,
    step: 8,
    value: 128,
    unit: " MB",
    group: "Agent",
    help: "Memory available to the agent queue. The model assumes about 2,000 buffered lines per MB.",
    format: "number" as const,
  },
  {
    id: "egressRate",
    label: "Egress capacity",
    min: 2_000,
    max: 80_000,
    step: 1_000,
    value: 40_000,
    unit: " lines/s",
    group: "Agent",
    help: "Lines per second the collector and backend accept from this agent. Backend throttling lowers the real value.",
    format: "rps" as const,
  },
  {
    id: "diskBufferMb",
    label: "Disk buffer",
    min: 0,
    max: 4_096,
    step: 128,
    value: 0,
    unit: " MB",
    group: "Agent",
    help: "Optional filesystem buffer. It adds capacity and survives restarts, but buffered logs wait longer before delivery.",
    format: "number" as const,
  },
  {
    id: "errorReserve",
    label: "Error and warning reserve",
    min: 0,
    max: 100,
    step: 5,
    value: 25,
    unit: "%",
    group: "Drop policy",
    help: "Protection for error and warning logs. Above their share of traffic, debug and info are dropped first; at 0 the policy is first-in, first-out.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  logRate: number;
  egressRate: number;
  reservePct: number;
  memoryLines: number;
  diskLines: number;
  capacityLines: number;
  shortfall: number;
  shortfallPct: number;
  protectedRate: number;
}

function compute(p: Params): Computed {
  const logRate = Math.max(1, num(p, "logRate", 20_000));
  const bufferMb = Math.max(1, num(p, "bufferMb", 128));
  const egressRate = Math.max(1, num(p, "egressRate", 40_000));
  const diskMb = Math.max(0, num(p, "diskBufferMb", 0));
  const reservePct = clamp(num(p, "errorReserve", 25), 0, 100);
  const memoryLines = Math.round(bufferMb * MEMORY_LINES_PER_MB);
  const diskLines = Math.round(diskMb * DISK_LINES_PER_MB);
  const capacityLines = memoryLines + diskLines;
  const shortfall = Math.max(0, logRate - egressRate);
  const protectedRate = logRate * PROTECTED_SHARE;
  return {
    logRate,
    egressRate,
    reservePct,
    memoryLines,
    diskLines,
    capacityLines,
    shortfall,
    shortfallPct: clamp((shortfall / logRate) * 100, 0, 100),
    protectedRate,
  };
}

interface QueueState {
  depth: number;
  delivered: number;
  dropRate: number;
  errorDropRate: number;
  age: number;
  shrinkLoss: number;
}

function initialQueueState(values: Computed): QueueState {
  return {
    depth: 0,
    delivered: Math.min(values.logRate, values.egressRate),
    dropRate: 0,
    errorDropRate: 0,
    age: 0,
    shrinkLoss: 0,
  };
}

function errorDropFor(values: Computed, dropRatePct: number): number {
  if (dropRatePct <= 0) return 0;
  const protectedDrop = clamp(
    (values.protectedRate - values.egressRate) / Math.max(1, values.protectedRate),
    0,
    1,
  ) * 100;
  const reserveRatio = clamp(values.reservePct / (PROTECTED_SHARE * 100), 0, 1);
  return clamp(dropRatePct * (1 - reserveRatio) + protectedDrop * reserveRatio, 0, 100);
}

function levelDropRates(values: Computed, dropRatePct: number): { debug: number; info: number } {
  if (dropRatePct <= 0) return { debug: 0, info: 0 };
  const droppedLines = values.logRate * (dropRatePct / 100);
  const debugArrival = values.logRate * DEBUG_SHARE;
  const infoArrival = values.logRate * INFO_SHARE;
  const debugPriority = clamp(droppedLines / Math.max(1, debugArrival), 0, 1) * 100;
  const infoPriority =
    clamp((droppedLines - debugArrival) / Math.max(1, infoArrival), 0, 1) * 100;
  const protection = clamp(values.reservePct / (PROTECTED_SHARE * 100), 0, 1);
  return {
    debug: clamp(dropRatePct * (1 - protection) + debugPriority * protection, 0, 100),
    info: clamp(dropRatePct * (1 - protection) + infoPriority * protection, 0, 100),
  };
}

function statusFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worstHealth(...states: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return states.reduce<Health>((worst, state) => (rank[state] > rank[worst] ? state : worst), "ok");
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, state: QueueState): SimFrame {
  const values = compute(p);
  const bufferUsedPct = clamp((state.depth / Math.max(1, values.capacityLines)) * 100, 0, 100);
  const pressurePct = Math.max(bufferUsedPct, values.shortfallPct);
  const agentHealth = worstHealth(
    statusFor(bufferUsedPct, 70, 90),
    statusFor(state.errorDropRate, 0.5, 2),
    statusFor(state.age, 60, 300),
    statusFor(values.shortfall, 10_000, 30_000),
    statusFor(state.shrinkLoss, 1, 1),
  );
  const collectorHealth: Health = values.shortfall > 0 ? "warn" : "ok";
  const backendHealth: Health = values.shortfall > 0 ? "warn" : "ok";
  const diskEngaged = values.diskLines > 0 && state.depth > values.memoryLines;
  const levelDrops = levelDropRates(values, state.dropRate);
  const warnDrop = state.errorDropRate;

  return {
    t: 0,
    nodes: [
      {
        id: "apps",
        label: "Applications",
        kind: "service",
        health: "ok",
        utilization: clamp(values.logRate / 120_000),
        sublabel: `${formatNumber(values.logRate)} lines/s produced`,
        detail: `${formatNumber(values.logRate)} log lines per second. The application is not blocked by the agent in this model; that is why it can stay green while telemetry is lost.`,
        meta: { view: "flow" },
      },
      {
        id: "agent",
        label: "Log agent",
        kind: "queue",
        health: agentHealth,
        utilization: clamp(pressurePct / 100),
        sublabel: `${formatNumber(state.depth)} / ${formatNumber(values.capacityLines)} lines buffered; ${values.shortfallPct.toFixed(0)}% above egress`,
        detail: `Ingest ${formatNumber(values.logRate)} lines/s, egress ${formatNumber(values.egressRate)} lines/s, shortfall ${formatNumber(values.shortfall)} lines/s. Buffer is ${bufferUsedPct.toFixed(0)}% used${diskEngaged ? "; disk buffer is holding records" : ""}.${state.shrinkLoss > 0 ? ` ${formatNumber(state.shrinkLoss)} lines were discarded when capacity shrank.` : ""}`,
        meta: { view: "flow", bufferPct: bufferUsedPct, depth: state.depth },
      },
      {
        id: "collector",
        label: "Collector",
        kind: "worker",
        health: collectorHealth,
        utilization: clamp(state.delivered / Math.max(1, values.egressRate)),
        sublabel: `${formatNumber(state.delivered)} lines/s delivered`,
        detail: `The collector can accept ${formatNumber(values.egressRate)} lines/s. It is saturated when the shortfall is above zero, even if the backend has not rejected a request yet.`,
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Log backend",
        kind: "storage",
        health: backendHealth,
        utilization: clamp(state.delivered / Math.max(1, values.egressRate)),
        sublabel: "ingest endpoint",
        detail: "The backend is modelled as a fixed acceptance rate. In production its real limit is visible as throttle responses, write latency, and rejected batches.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("apps-agent", "apps", "agent", clamp(values.logRate / 120_000), agentHealth),
      edge(
        "agent-collector",
        "agent",
        "collector",
        clamp(state.delivered / Math.max(1, values.logRate)),
        collectorHealth,
      ),
      edge(
        "collector-backend",
        "collector",
        "backend",
        clamp(state.delivered / Math.max(1, values.egressRate)),
        backendHealth,
      ),
    ],
    metrics: [
      metric("egress-shortfall", "Egress shortfall", values.shortfall, " lines/s", 10_000, 30_000, "rps"),
      metric("buffer-used", "Buffer used", bufferUsedPct, "%", 70, 90, "percent"),
      metric("error-drop", "Error log drop rate", state.errorDropRate, "%", 0.5, 2, "percent"),
      metric("warn-drop", "Warning log drop rate", warnDrop, "%", undefined, undefined, "percent"),
      metric("oldest-age", "Estimated buffer drain delay", state.age, "s", 60, 300, "number"),
      metric("queueDepth", "Buffered log lines", state.depth, " lines", undefined, undefined, "count"),
      metric("shrink-loss", "Backlog discarded on shrink", state.shrinkLoss, " lines", undefined, undefined, "count"),
      metric("drop-rate", "Overall drop rate", state.dropRate, "%", undefined, undefined, "percent"),
      metric("debug-drop", "Debug log drop rate", levelDrops.debug, "%", undefined, undefined, "percent"),
      metric("info-drop", "Info log drop rate", levelDrops.info, "%", undefined, undefined, "percent"),
      metric("log-ingest", "Log ingest rate", values.logRate, " lines/s", undefined, undefined, "rps"),
      metric("log-delivered", "Delivered rate", state.delivered, " lines/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, depth: state.depth },
    summary: `${formatNumber(state.depth)} lines buffered, ${bufferUsedPct.toFixed(0)}% used; ${state.errorDropRate.toFixed(1)}% of error logs dropped; estimated buffer drain delay ${state.age.toFixed(0)}s${state.shrinkLoss > 0 ? `; ${formatNumber(state.shrinkLoss)} lines discarded on shrink` : ""}.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, state: QueueState, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.9);
  const entries: [string, number, number][] = [
    ["egress-shortfall", values.shortfall, 0],
    ["buffer-used", (state.depth / Math.max(1, values.capacityLines)) * 100, 0],
    ["error-drop", state.errorDropRate, 0],
    ["warn-drop", state.errorDropRate, 0],
    ["oldest-age", state.age, 0],
    ["queueDepth", state.depth, 0],
    ["shrink-loss", 0, 0],
    ["drop-rate", state.dropRate, 0],
    ["debug-drop", 0, 0],
    ["info-drop", 0, 0],
    ["log-ingest", values.logRate, 400],
    ["log-delivered", state.delivered, 300],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "egress-shortfall",
    metricId: "egress-shortfall",
    warn: 10_000,
    crit: 30_000,
    title: "Log ingest exceeds egress capacity",
    cause:
      "Applications are producing more log lines per second than the agent can deliver. The buffer absorbs the gap for a while, but it does not add egress capacity.",
    fix:
      "Reduce log volume at the source, restore backend capacity, or accept a deliberate drop policy that preserves errors. Adding buffer alone only moves the loss later.",
    checkFirst: [
      "Compare the agent's ingest rate with its delivered rate and retry count.",
      "Check whether the backend is throttling or rejecting batches.",
      "Check for a recent debug-level or verbose-request-logging change.",
    ],
  },
  {
    id: "buffer-used",
    metricId: "buffer-used",
    warn: 70,
    crit: 90,
    title: "The agent buffer is nearly full",
    cause:
      "The buffer is absorbing a sustained difference between ingest and egress. Once it fills, the drop policy decides which levels are lost.",
    fix:
      "Protect error logs first, drop debug and info before warnings, and restore egress headroom. A larger disk buffer delays the decision but makes the retained logs older.",
    checkFirst: [
      "Check buffer usage by agent, not only the fleet total.",
      "Check whether the disk buffer is enabled and how old its records are.",
      "Check whether a single noisy workload is responsible for the volume.",
    ],
  },
  {
    id: "error-drop",
    metricId: "error-drop",
    warn: 0.5,
    crit: 2,
    title: "Error logs are being dropped",
    cause:
      "The drop policy is losing error logs. This happens when the reserve is too small for the error volume, or when error and warning volume alone exceeds egress capacity.",
    fix:
      "Raise the error reserve, cut non-error volume, and add egress capacity if protected volume exceeds the pipe. Do not make application threads block on the agent to avoid the drop.",
    checkFirst: [
      "Compare the error drop rate with the overall drop rate.",
      "Check whether the reserved share is below the error and warning share of traffic.",
      "Check whether egress is smaller than the protected log rate.",
    ],
  },
  {
    id: "oldest-age",
    metricId: "oldest-age",
    warn: 60,
    crit: 300,
    title: "Estimated buffer drain delay is too long",
    cause:
      "Queued logs are waiting in the buffer for too long. A large disk buffer can hold evidence for minutes while the incident has already moved on.",
    fix:
      "Bound the buffer by time as well as size, reduce the shortfall, and route errors on a separate low-latency path. Drain delay is the cost of using storage as capacity.",
    checkFirst: [
      "Check the estimated drain delay, not just the number of buffered records.",
      "Check whether a disk buffer is replaying a backlog after a restart.",
      "Check whether error logs share the same queue as debug logs.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const logPipelineModel: SimModel = {
  id: "observability-log-pipeline-backpressure",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const state = initialQueueState(values);
    const frame = buildFrame(defaults(), seed, state);
    seedSeries(frame, values, state, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const step = clamp(dt, 0.01, 1);
    const rawDepth = frame.flags.depth;
    const previousDepth =
      typeof rawDepth === "number" && Number.isFinite(rawDepth) ? Math.max(0, rawDepth) : 0;
    const jitter = 1 + rng.between(-0.01, 0.01);
    const capacityLoss = Math.max(0, previousDepth - values.capacityLines);
    const startDepth = Math.min(previousDepth, values.capacityLines);
    const inflow = values.logRate * step;
    const drain = Math.min(values.egressRate * step, startDepth + inflow);
    const available = Math.max(0, values.capacityLines - Math.max(0, startDepth - drain));
    const accepted = Math.min(inflow, available);
    const depth = clamp(startDepth - drain + accepted, 0, values.capacityLines);
    const dropped = Math.max(0, inflow - accepted) / step;
    const dropRate = clamp((dropped / Math.max(1, values.logRate)) * 100, 0, 100);
    const errorDropRate = errorDropFor(values, dropRate);
    const delivered = Math.min(values.egressRate, (drain / step) * jitter);
    const state: QueueState = {
      depth,
      delivered: Math.max(0, delivered),
      dropRate,
      errorDropRate,
      age: depth / Math.max(1, values.egressRate),
      shrinkLoss: capacityLoss,
    };
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), state);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (capacityLoss > 0) {
      pushEvent(next, {
        id: "buffer-shrink-loss",
        at: frame.t + step,
        severity: "crit",
        title: "Buffer shrink discarded backlog",
        detail: `Capacity fell to ${formatNumber(values.capacityLines)} lines while ${formatNumber(previousDepth)} were buffered; ${formatNumber(capacityLoss)} lines were discarded.`,
        nodeId: "agent",
        metricId: "shrink-loss",
      });
    }

    if (dropRate > 0 && frame.flags.overflowSeen !== 1) {
      pushEvent(next, {
        id: "agent-buffer-overflow",
        at: frame.t + step,
        severity: "crit",
        title: "Agent buffer overflow",
        detail: `The buffer is full and ${formatNumber(dropped)} lines/s are being dropped. Error logs are ${errorDropRate.toFixed(1)}% of their own arrival rate.`,
        nodeId: "agent",
        metricId: "error-drop",
      });
      next.flags.overflowSeen = 1;
    }
    if (dropRate <= 0) next.flags.overflowSeen = 0;

    if (state.depth > values.memoryLines && values.diskLines > 0 && frame.flags.diskSeen !== 1) {
      pushEvent(next, {
        id: "disk-buffer-engaged",
        at: frame.t + step,
        severity: "warn",
        title: "Disk buffer engaged",
        detail: `The memory buffer is full. Records are spilling to disk and will wait about ${state.age.toFixed(0)}s at the current egress rate.`,
        nodeId: "agent",
        metricId: "oldest-age",
      });
      next.flags.diskSeen = 1;
    }
    if (state.depth <= values.memoryLines) next.flags.diskSeen = 0;

    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${formatNumber(state.depth)} lines buffered, ${((state.depth / Math.max(1, values.capacityLines)) * 100).toFixed(0)}% used; ${state.errorDropRate.toFixed(1)}% of error logs dropped; estimated buffer drain delay ${state.age.toFixed(0)}s${state.shrinkLoss > 0 ? `; ${formatNumber(state.shrinkLoss)} lines discarded on shrink` : ""}.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const state = {
      depth: frame.metrics.find((item) => item.id === "queueDepth")?.value ?? 0,
      age: frame.metrics.find((item) => item.id === "oldest-age")?.value ?? 0,
      errorDropRate: frame.metrics.find((item) => item.id === "error-drop")?.value ?? 0,
    };
    const items: string[] = [];
    const atCapacity = state.depth >= values.capacityLines - 0.5;
    if (values.shortfall > 0) {
      if (atCapacity) {
        items.push(
          `The buffer is full; the ${formatNumber(values.shortfall)} lines/s shortfall is being dropped now.`,
        );
      } else {
        const secondsToFull =
          (values.capacityLines - state.depth) / Math.max(1, values.shortfall);
        items.push(
          `Ingest is ${formatNumber(values.shortfall)} lines/s above egress. At that gap, the buffer adds about ${secondsToFull.toFixed(1)}s before it is full.`,
        );
      }
    } else if (state.depth > 0) {
      items.push(
        `Ingest is ${formatNumber(values.egressRate - values.logRate)} lines/s below egress capacity; the buffer is draining, not filling.`,
      );
    } else {
      items.push(
        `Ingest is ${formatNumber(values.egressRate - values.logRate)} lines/s below egress capacity; the buffer is empty.`,
      );
    }
    if (state.depth > values.memoryLines && values.diskLines > 0) {
      items.push(
        `The memory buffer is full and the disk buffer is holding the overflow. Estimated buffer drain delay is ${state.age.toFixed(0)}s.`,
      );
    } else if (state.depth > 0) {
      items.push(
        `The buffer holds ${formatNumber(state.depth)} lines, about ${state.age.toFixed(0)}s of estimated drain delay at the current egress rate.`,
      );
    }
    if (state.errorDropRate > 0) {
      items.push(
        `Error logs are being dropped at ${state.errorDropRate.toFixed(1)}%. The ${values.reservePct}% reserve is not enough to keep protected volume inside egress.`,
      );
    } else if (
      state.depth > 0 &&
      values.shortfall > 0 &&
      atCapacity &&
      values.reservePct >= PROTECTED_SHARE * 100
    ) {
      items.push(
        `Error logs are protected by a ${values.reservePct}% reserve; debug and info records are absorbing the loss while the shortfall remains.`,
      );
    } else if (state.depth > 0 && values.shortfall > 0 && !atCapacity) {
      items.push(
        `The buffer is filling and no drops have started. With a ${values.reservePct}% reserve, error logs will drop in proportion once the buffer fills.`,
      );
    } else if (state.depth > 0) {
      items.push(
        "No new drops are occurring while the buffer drains; error logs are not at risk in this state.",
      );
    }
    const debugDrop = frame.metrics.find((item) => item.id === "debug-drop")?.value ?? 0;
    const infoDrop = frame.metrics.find((item) => item.id === "info-drop")?.value ?? 0;
    const warnDropValue = frame.metrics.find((item) => item.id === "warn-drop")?.value ?? 0;
    const shrinkLoss = frame.metrics.find((item) => item.id === "shrink-loss")?.value ?? 0;
    if (shrinkLoss > 0) {
      items.push(
        `Buffer capacity was reduced below the current depth; ${formatNumber(shrinkLoss)} buffered lines were discarded.`,
      );
    }
    if (debugDrop > 0 || infoDrop > 0 || state.errorDropRate > 0) {
      items.push(
        `Drops by level: debug ${debugDrop.toFixed(1)}%, info ${infoDrop.toFixed(1)}%, warning ${warnDropValue.toFixed(1)}%, error ${state.errorDropRate.toFixed(1)}%.`,
      );
    }
    items.push(
      `Each MB of memory holds about ${MEMORY_LINES_PER_MB.toLocaleString("en-US")} lines in this model; the disk buffer adds the same density per MB but does not raise egress capacity.`,
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
    description: "20k lines/s against 40k lines/s of egress. The buffer is empty.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "36k lines/s against 30k lines/s of egress. The buffer absorbs the gap but is filling.",
    tone: "warn",
    params: defaults({ logRate: 36_000, bufferMb: 256, egressRate: 30_000 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "80k lines/s against 2k lines/s of egress with no priority reserve. Error logs drop with everything else.",
    tone: "crit",
    params: defaults({ logRate: 80_000, bufferMb: 32, egressRate: 2_000, errorReserve: 0 }),
  },
  {
    id: "disk-buffer",
    label: "Add disk buffer",
    description: "The same overload with 1 GB of disk and a 25% reserve. Errors survive; debug still drops and logs age.",
    tone: "crit",
    params: defaults({
      logRate: 80_000,
      bufferMb: 32,
      egressRate: 20_000,
      diskBufferMb: 1_024,
      errorReserve: 25,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Cut ingest to 20k lines/s and restore 40k lines/s of egress with a 25% error reserve.",
    tone: "ok",
    params: defaults({ logRate: 20_000, egressRate: 40_000, errorReserve: 25 }),
  },
];

const experiment: Experiment = {
  id: "predict-drop-order",
  title: "Predict which logs are lost",
  simId: "log-pipeline",
  question:
    "At 80k lines/s, 2k lines/s of egress, a 32 MB buffer, and no error reserve, which logs are dropped first?",
  prediction: {
    options: [
      { id: "proportional", label: "Every level drops in proportion to its share, including errors" },
      { id: "debug-only", label: "Only debug logs drop; errors are always preserved" },
      { id: "no-loss", label: "Nothing drops because the buffer eventually absorbs the backlog" },
      { id: "app-block", label: "The application blocks until the backend catches up" },
    ],
    correctOptionId: "proportional",
    explanation:
      "With a zero reserve the policy is first-in, first-out. Errors are about 1% of arrivals, so they are about 1% of the dropped records once the buffer is full. A priority reserve is what changes the order; it does not create egress capacity.",
  },
  setup: defaults({
    logRate: 80_000,
    bufferMb: 32,
    egressRate: 2_000,
    diskBufferMb: 0,
    errorReserve: 0,
  }),
  runFor: 20,
  observe: [
    "Egress shortfall is 78k lines/s and critical on the first evaluation.",
    "The 32 MB memory buffer fills in under a second and stays at 100%.",
    "The overall drop rate is near 97.5%, and debug, info, warning, and error logs all drop at that same rate.",
    "The estimated buffer drain delay is only about 32 seconds because the buffer is small.",
    "The application stays green while the agent and collector fail or saturate.",
  ],
  explain:
    "A FIFO agent does not know that an error line matters more than a debug line. When ingress is forty times egress, almost everything is dropped, and errors are almost everything's share. A priority reserve keeps errors and warnings until protected volume itself exceeds egress. That is why the policy and the capacity are separate decisions.",
  fix: defaults({
    logRate: 20_000,
    bufferMb: 128,
    egressRate: 40_000,
    diskBufferMb: 0,
    errorReserve: 25,
  }),
  debrief:
    "Cutting debug volume and restoring egress removes the shortfall; the reserve keeps errors safe if the next spike returns. The remaining cost is that debug logs for the incident are gone, so the trace and the structured error fields must carry the diagnosis. A larger buffer would only defer that loss.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An application writes a log line, a node-level agent batches and buffers it, a collector forwards it, and a backend indexes it. The agent's buffer is finite. When application output exceeds what the pipeline can deliver, the buffer fills. After that, the agent must either stop accepting data, which pushes back on the application, or drop records. A log pipeline is a queue with a policy, not a pipe.",
  },
  {
    type: "p",
    text: "Backpressure is easy to defer and expensive to discover. A memory buffer hides a small gap for seconds. A disk buffer hides a larger gap for minutes. Neither increases egress capacity. During an incident, log volume often rises at the same moment the backend slows down, so the buffer sized for normal traffic fills exactly when it is most needed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application, node agent, collector, and log backend. The agent owns the local buffer. The collector owns a second queue and retry policy. The backend owns ingest limits. Error logs are a small share of volume, so a first-in, first-out drop policy loses them in proportion to their share. A priority policy reserves buffer space and delivery order for errors and warnings, then drops debug and info first.",
  },
  {
    type: "table",
    headers: ["Lever", "What it buys", "What it costs"],
    rows: [
      ["Memory buffer", "Seconds of absorption for a short spike", "Fills quickly; heap pressure; drops when full"],
      ["Disk buffer", "Minutes of absorption and survival across restarts", "Older logs, disk I/O, replay competes with live traffic"],
      ["Priority reserve", "Keeps errors and warnings through a noise flood", "Fewer slots for debug; protected volume can still exceed egress"],
      ["More egress", "Removes the shortfall itself", "Cost and backend capacity; the backend may be the degraded component"],
      ["Source sampling", "Cuts volume before the agent", "Discarded debug lines cannot be recovered later"],
    ],
  },
  {
    type: "p",
    text: "The model uses about 2,000 lines per MB, a 1% error share, a 4% warning share, and fixed acceptance rates. Buffer sizes, rates, and thresholds are illustrative teaching values, not Fluent Bit or OpenTelemetry defaults. The shape is the lesson: a bounded queue, a policy that decides who is lost, and a second cost that appears as delay.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Ingest and delivered rates, plus the shortfall between them.",
      "Buffer used and queue depth for the agent's memory and optional disk buffer.",
      "Drop rates for error, warning, info, and debug logs, plus the overall rate.",
      "Estimated buffer drain delay, the cost of using a larger buffer.",
      "Node states for the application, agent, collector, and backend.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Failure. Watch the shortfall go critical before the buffer fills, then watch error-log drops. Compare Add disk buffer and Recovery. Switch to Flow to see the application stay green while the agent fails; that gap is the reason this module exists.",
  },
  { type: "sim", simId: "log-pipeline" },
  { type: "experiment", experimentId: "predict-drop-order" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 80k lines/s against 2k lines/s of egress, the agent had forty times more input than output. The 32 MB memory buffer held about 64k lines and filled in under a second. With no priority reserve, the drop policy was first-in, first-out: error logs were about 1% of arrivals and about 1% of drops, so the error drop rate tracked the overall drop rate near 97.5%. The application stayed healthy because the agent dropped records instead of blocking application threads.",
  },
  {
    type: "p",
    text: "The disk buffer changed the shape, not the capacity problem. A 1 GB disk buffer delayed the drops and pushed the estimated buffer drain delay past a minute, while the shortfall stayed critical. The priority reserve kept error logs through the flood and let debug absorb the loss. Recovery required reducing input and restoring egress headroom, not a larger buffer.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Agent metrics: input and output record counts, retries, dropped records, buffer usage, filesystem storage usage, and paused or resumed input events.",
      "Collector metrics: exporter queue size and capacity, send failures, refused records, and retry counts.",
      "Backend: throttle responses, write latency, rejected batches, and the gap between event time and ingest time.",
      "Agent logs: a paused input message when a memory limit is reached, resume messages, disk write errors, and retry exhaustion.",
      "Application metrics: request latency may stay flat while telemetry is lost. Application health is not proof that logs arrived.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare ingest with delivered rate at the agent, then decide whether the backend is rejecting or the agent is paused. Before raising a buffer, decide which levels you are willing to lose and verify that error logs survive the policy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the source: lower debug to info, sample high-volume debug, or disable verbose request logging for the duration.",
      "Protect errors: set a priority reserve for error and warning logs, then verify it under load instead of trusting the configuration.",
      "Restore egress: reduce backend throttling, add capacity, or route error logs on a separate low-latency path.",
      "Bound the buffer by time as well as size. A disk buffer that holds hours of logs hides the outage and delays evidence.",
      "Verify with ingest, delivered, drop by level, estimated drain delay, and a synthetic error log that must survive.",
      "Re-run at peak and confirm application latency did not move while the pipeline stayed inside its drop budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Blocking the producer preserves every record and couples telemetry to request latency. Dropping decouples them and loses evidence.",
      "Memory buffers are fast and small. Disk buffers are larger and slower, and they make every retained log older.",
      "A high error reserve protects evidence but can starve debug and info exactly when you need context.",
      "Sampling at the source reduces cost but is irreversible. You cannot reconstruct a debug line that was never sent.",
      "A second pipeline for errors adds cost and another failure domain, but it keeps the important path short.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-agent-backpressure",
    question:
      "The application is healthy, but the log dashboard is missing records for the last ten minutes. How do you tell whether the agent is paused or the backend is rejecting data?",
    difficulty: 3,
    hints: [
      "Compare the agent's input rate with its delivered rate before looking at the backend.",
      "A paused input and a rejected batch produce different retry and error signals.",
    ],
    answer:
      "I would start at the agent. If input records are arriving but output records are flat, the problem is local backpressure: the buffer is full and the input is paused or dropping. If output is being attempted and retries or send failures are rising, the problem is downstream: the backend is rejecting or timing out. I would check buffer usage, the estimated drain delay, retry counters, and the agent's own logs for paused and resumed events. At the backend I would check throttle responses, write latency, and rejected batches. The two failures look similar on a missing-log dashboard but require different fixes.",
    followUps: [
      "What does a paused input do to the application if it is a synchronous logger?",
      "Which metric would distinguish a full buffer from a slow backend?",
      "How would a disk buffer change the diagnosis?",
    ],
    redFlags: [
      "Blames the application before checking the agent.",
      "Adds buffer without checking the backend.",
      "Treats a retry counter as proof of delivery.",
    ],
    rubric: [
      "Separates local backpressure from downstream rejection.",
      "Names input, output, retry, and drain-delay signals.",
      "Checks paused and resumed events.",
      "Chooses a fix that matches the failing hop.",
    ],
  },
  {
    id: "size-buffer",
    question:
      "Why not give every log agent a very large disk buffer and stop worrying about drops?",
    difficulty: 3,
    hints: [
      "A buffer converts a capacity problem into a delay and a recovery problem.",
      "Ask what happens when the disk fills or the agent restarts.",
    ],
    answer:
      "A large disk buffer does not add egress capacity. It lets the agent accept more records during the gap, but those records wait longer and are less useful by the time they arrive. When the disk fills, the drop returns, often with less warning. A restart has to replay the backlog while new logs are still arriving, so recovery competes with live traffic. Disk failures lose the buffer entirely. I would bound the buffer by both size and age, keep errors on a shorter path, and treat buffer depth as a signal that the pipeline is short of egress, not as the fix.",
    followUps: [
      "How would you choose a maximum drain delay?",
      "What happens to replay order after a restart?",
      "When is a disk buffer still the right choice?",
    ],
    redFlags: [
      "Treats disk as infinite capacity.",
      "Ignores replay cost and ordering.",
      "Does not bound the buffer by time.",
    ],
    rubric: [
      "Explains that buffering delays rather than removes loss.",
      "Names replay, disk failure, and age costs.",
      "Proposes a time bound.",
      "Keeps a short path for errors.",
    ],
  },
  {
    id: "choose-drop-policy",
    question:
      "You have to drop logs during a spike. How do you decide which levels to drop, and how do you verify the policy works?",
    difficulty: 3,
    hints: [
      "Start from the questions the logs must answer after the incident.",
      "A policy that is not tested under load is only a hope.",
    ],
    answer:
      "I would preserve errors and warnings first because they explain impact and failed requests. Debug goes first, then info. I would reserve buffer space and delivery order for the protected levels, and I would cap the protected volume so it cannot starve the pipeline. I would verify with a synthetic error line during a load test, not just by reading the config: inject a known error at the same time as a debug flood and confirm it arrives with an acceptable age. I would also record counts by level so the next incident can show what was lost.",
    followUps: [
      "What if the product needs info logs for audit?",
      "How does sampling interact with a priority reserve?",
      "What would you do if protected volume exceeds egress?",
    ],
    redFlags: [
      "Drops errors and keeps debug because debug is louder.",
      "Never tests the policy.",
      "Blocks request threads instead of dropping.",
    ],
    rubric: [
      "Orders levels by diagnostic value.",
      "Reserves capacity and delivery order.",
      "Tests with a synthetic error.",
      "Measures loss by level.",
    ],
  },
  {
    id: "incident-error-loss",
    question:
      "During a traffic spike, error logs are being dropped even though the agent has a priority reserve. What do you check, and what do you change first?",
    difficulty: 4,
    hints: [
      "The reserve protects order, not capacity.",
      "Compare the protected arrival rate with egress.",
    ],
    answer:
      "I would compare the error and warning arrival rate with egress capacity. If protected volume alone is above egress, no reserve can keep every error; the pipeline is short of capacity. I would cut debug and info at the source immediately, then raise egress or move errors to a separate path. I would check whether the reserve is actually configured on every agent and whether a parser or filter is adding volume before the buffer. Raising the buffer would only delay the same loss. After recovery I would add a synthetic error check and an alert on error-drop rate, not only on overall drop rate.",
    followUps: [
      "How would you prove the reserve is applied on every agent?",
      "What is the risk of a separate error pipeline?",
      "Which signal tells you the fix worked?",
    ],
    redFlags: [
      "Raises the buffer and declares victory.",
      "Looks only at overall drop rate.",
      "Assumes the reserve creates capacity.",
    ],
    rubric: [
      "Compares protected volume with egress.",
      "Cuts non-error volume first.",
      "Checks configuration coverage.",
      "Verifies error delivery end to end.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every agent has a bounded memory buffer and, if used, a time-bounded disk buffer.",
      "The drop policy is written down and names which levels are protected.",
      "Error and warning volume is measured separately from total volume.",
      "A synthetic error log is part of the load test and is checked end to end.",
      "Backend ingest limits, retry behavior, and throttle responses are documented.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare ingest with delivered rate before changing the buffer.",
      "Check whether the agent is paused, dropping, or retrying before blaming the backend.",
      "Cut debug and info volume at the source before raising a reserve.",
      "Watch error-drop rate and estimated drain delay, not only overall drop rate.",
      "Record which levels were lost and for how long.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that error logs from the incident survived with an acceptable age.",
      "Reconcile the buffer size and age limits with the egress capacity you actually have.",
      "Add an alert on error-drop rate and shortfall, not only on buffer usage.",
      "Remove temporary sampling and confirm the pipeline returns to its normal shape.",
      "Update the runbook with the drop order and the escalation path.",
    ],
  },
];

const references = [
  {
    title: "Backpressure",
    url: "https://docs.fluentbit.io/manual/administration/backpressure",
    publisher: "Fluent Bit",
    kind: "docs" as const,
    note: "Memory and filesystem buffering, input pausing, and the consequences of a full buffer.",
  },
  {
    title: "Buffering",
    url: "https://docs.fluentbit.io/manual/data-pipeline/buffering",
    publisher: "Fluent Bit",
    kind: "docs" as const,
    note: "Memory-only and filesystem buffering modes, queue limits, and dropped records.",
  },
  {
    title: "Memory Limiter Processor",
    url: "https://github.com/open-telemetry/opentelemetry-collector/blob/main/processor/memorylimiterprocessor/README.md",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Refusing data under memory pressure and propagating backpressure through receivers.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "log-pipeline": {
      model: logPipelineModel,
      presets,
      instructions:
        "Start Healthy, then apply Failure. Compare Add disk buffer and Recovery. Watch the shortfall first, then buffer use, then error-log drops.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Buffer density, level shares, acceptance rates, and thresholds are teaching values, not vendor defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-backpressure",
    "observability-structured-logging",
    "observability-log-volume-cost",
    "observability-meta-monitoring",
  ],
};
