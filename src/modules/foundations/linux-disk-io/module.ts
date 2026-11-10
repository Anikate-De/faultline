import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DEVICE_IOPS = 6_000;
const DEVICE_MBPS = 125;
const QUEUE_LIMIT = 32;
const BASE_MS = 0.4;

const params = [
  {
    id: "iopsDemand",
    label: "Read/write IOPS demand",
    min: 500,
    max: 20_000,
    step: 100,
    value: 1_500,
    unit: " IOPS",
    group: "Workload",
    help: "Random reads and writes per second, before fsync overhead.",
    format: "count" as const,
  },
  {
    id: "writeShare",
    label: "Write share",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Workload",
    help: "Share of operations that write. Writes add journal traffic and make fsync part of the durability path.",
    format: "percent" as const,
  },
  {
    id: "fsyncRate",
    label: "fsync rate",
    min: 0,
    max: 3_000,
    step: 50,
    value: 100,
    unit: " /s",
    group: "Durability",
    help: "Durable commits per second. Each fsync waits for the device to make the write persistent.",
    format: "count" as const,
  },
  {
    id: "ioSizeKb",
    label: "Average I/O size",
    min: 4,
    max: 128,
    step: 4,
    value: 16,
    unit: " KB",
    group: "Workload",
    help: "Average request size. Larger I/O consumes more bandwidth per operation and can hit the throughput limit first.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  iopsDemand: number;
  writeShare: number;
  fsyncRate: number;
  ioSizeKb: number;
  totalIops: number;
  writeAmplification: number;
  mbps: number;
  iopsUtil: number;
  bwUtil: number;
  util: number;
  queueDepth: number;
  p99: number;
  fsyncP99: number;
  iowait: number;
}

function compute(p: Params): Computed {
  const iopsDemand = Math.max(1, num(p, "iopsDemand", 1_500));
  const writeShare = clamp(num(p, "writeShare", 40) / 100);
  const fsyncRate = Math.max(0, num(p, "fsyncRate", 100));
  const ioSizeKb = Math.max(1, num(p, "ioSizeKb", 16));
  const totalIops = iopsDemand + fsyncRate * 0.25;
  const writeAmplification = 1 + writeShare * 0.35;
  const mbps = (totalIops * ioSizeKb * writeAmplification) / 1_024;
  const iopsUtil = totalIops / DEVICE_IOPS;
  const bwUtil = mbps / DEVICE_MBPS;
  const util = Math.max(iopsUtil, bwUtil);
  const queueDepth =
    util >= 1 ? QUEUE_LIMIT : Math.min(QUEUE_LIMIT, 1 + (8 * util) / Math.max(0.02, 1 - util));
  const p99 =
    util >= 1.05
      ? 5_000
      : Math.min(5_000, BASE_MS + (12 * (util / Math.max(0.02, 1 - util)) ** 1.5));
  const fsyncP99 =
    fsyncRate === 0
      ? 0
      : Math.min(5_000, p99 * 1.6 + 1 + fsyncRate / 125 + writeShare * 4);
  return {
    iopsDemand,
    writeShare: writeShare * 100,
    fsyncRate,
    ioSizeKb,
    totalIops,
    writeAmplification,
    mbps,
    iopsUtil,
    bwUtil,
    util,
    queueDepth,
    p99,
    fsyncP99,
    iowait: clamp(util * 35 + queueDepth * 0.4, 0, 100),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.7);
  const seeds: [string, number, number][] = [
    ["queueDepth", values.queueDepth, 0.1],
    ["fsync-p99", values.fsyncP99, 0.4],
    ["device-util", Math.min(100, values.util * 100), 0.4],
    ["iowait", values.iowait, 0.3],
    ["p99", values.p99, 0.4],
    ["throughput", values.mbps, 0.3],
    ["iops", values.totalIops, 2],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const volumeHealth = healthFor(Math.min(100, values.util * 100), 75, 90);
  const queueHealth = healthFor(values.queueDepth, 16, 30);
  const appHealth = healthFor(values.fsyncP99, 40, 150);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: appHealth,
        utilization: clamp(values.util),
        sublabel: `${Math.round(values.totalIops).toLocaleString()} IOPS`,
        detail: `${Math.round(values.fsyncRate)} fsync/s, p99 ${values.fsyncP99.toFixed(0)}ms.`,
        meta: { view: "queue" },
      },
      {
        id: "block-queue",
        label: "Block layer queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(values.queueDepth / QUEUE_LIMIT),
        sublabel: `${values.queueDepth.toFixed(1)} deep`,
        meta: { view: "queue" },
      },
      {
        id: "volume",
        label: "EBS volume",
        kind: "worker",
        health: volumeHealth,
        utilization: clamp(values.util),
        sublabel: `${values.mbps.toFixed(0)} MB/s`,
        detail: `Illustrative device: ${DEVICE_IOPS.toLocaleString()} IOPS, ${DEVICE_MBPS} MB/s, queue limit ${QUEUE_LIMIT}.`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("app-queue", "app", "block-queue", clamp(values.util), queueHealth),
      edge("queue-volume", "block-queue", "volume", clamp(values.util), volumeHealth),
    ],
    metrics: [
      metric("queueDepth", "Queue depth", values.queueDepth, "", 16, 30, "number"),
      metric("fsync-p99", "fsync p99", values.fsyncP99, "ms", 40, 150, "ms"),
      metric("device-util", "Device utilization", Math.min(100, values.util * 100), "%", 75, 90, "percent"),
      metric("iowait", "I/O wait", values.iowait, "%", 20, 40, "percent"),
      metric("p99", "I/O p99", values.p99, "ms", 50, 200, "ms"),
      metric("throughput", "Throughput demand", values.mbps, " MB/s", undefined, undefined, "number"),
      metric("iops", "Total IOPS", values.totalIops, " IOPS", undefined, undefined, "count"),
      metric("write-amp", "Write amplification", values.writeAmplification, "x", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.mbps.toFixed(0)} MB/s, ${Math.round(values.totalIops).toLocaleString()} IOPS, queue ${values.queueDepth.toFixed(1)}, fsync p99 ${values.fsyncP99.toFixed(0)}ms.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "fsync-p99",
    metricId: "fsync-p99",
    warn: 40,
    crit: 150,
    title: "Durable writes are breaching the write SLO",
    cause:
      "Every fsync waits for the device to commit the write. When the device queue is deep, the commit inherits the queueing delay and the durability cost becomes visible in application latency.",
    fix: "Reduce fsync frequency where the durability contract allows, group commits, reduce write amplification, or add a device with more IOPS or throughput. Caching writes above the device does not make fsync durable.",
    checkFirst: [
      "Compare fsync p99 with device await and queue depth.",
      "Check the application's fsync rate and write size.",
      "Check whether journaling or copy-on-write is amplifying the writes.",
    ],
  },
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 16,
    crit: 30,
    title: "The block queue is saturated",
    cause:
      "Demand is arriving faster than the device can complete it, or the I/O size has hit a throughput limit before the IOPS limit. Queue depth rises until the device's queue is full.",
    fix: "Find which limit binds: IOPS or MB/s. Smaller I/O reduces bandwidth per operation; fewer or larger sequential writes reduce IOPS. Add the resource that is actually short.",
    checkFirst: [
      "Compare IOPS utilization with throughput utilization.",
      "Check average request size and write amplification.",
      "Check whether a batch job started at the same time.",
    ],
  },
  {
    id: "device-util",
    metricId: "device-util",
    warn: 75,
    crit: 90,
    title: "The device is busy at its limit",
    cause:
      "The volume is spending most of its time servicing requests. Utilization near 100% means little headroom for bursts, even if the average latency still looks acceptable.",
    fix: "Add IOPS or throughput, reduce demand, or move the workload to a volume with a better fit. Check the queue before concluding that the device itself is slow.",
    checkFirst: [
      "Read iostat await and aqu-sz with %util.",
      "Compare the provisioned limits with the observed demand.",
      "Check for a single process generating most of the I/O.",
    ],
  },
  {
    id: "iowait",
    metricId: "iowait",
    warn: 20,
    crit: 40,
    title: "Tasks are blocked on storage",
    cause:
      "CPU is idle while tasks wait for I/O. High iowait is a symptom of storage latency, not CPU saturation; adding CPU would not shorten the wait.",
    fix: "Fix the storage path: reduce queueing, improve the I/O pattern, or add the missing IOPS or bandwidth.",
    checkFirst: [
      "Check the block device's await and queue depth.",
      "Check whether the workload is read or write heavy.",
      "Check for swap or page-cache thrashing.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 50,
    crit: 200,
    title: "I/O latency is climbing",
    cause:
      "Queueing delay grows nonlinearly as the device approaches saturation. The average can stay low while the tail absorbs the wait.",
    fix: "Reduce demand or add the limiting resource. Do not tune the application timeout to hide a storage queue.",
    checkFirst: [
      "Compare p99 with queue depth.",
      "Check whether reads or writes dominate the tail.",
      "Check the device's provisioned limits.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const linuxDiskIoModel: SimModel = {
  id: "foundations-linux-disk-io",
  visual: "queue",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    }
    const jitter = rng.between(-0.05, 0.05);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.util >= 1 && frame.flags.queueEvent !== 1) {
      pushEvent(next, {
        id: "queue-saturated",
        at: frame.t,
        severity: "crit",
        title: "The block queue is the bottleneck",
        detail: `${Math.round(values.totalIops).toLocaleString()} IOPS at ${values.ioSizeKb.toFixed(0)} KB needs ${values.mbps.toFixed(0)} MB/s, but the device offers ${DEVICE_MBPS} MB/s and ${DEVICE_IOPS.toLocaleString()} IOPS. Queue depth is pinned at ${QUEUE_LIMIT}.`,
        nodeId: "volume",
        metricId: "queueDepth",
      });
      next.flags.queueEvent = 1;
    }
    if (values.util < 0.9) next.flags.queueEvent = 0;
    next.flags.paramsKey = key;
    next.summary = `${values.mbps.toFixed(0)} MB/s, ${Math.round(values.totalIops).toLocaleString()} IOPS, queue ${values.queueDepth.toFixed(1)}, fsync p99 ${values.fsyncP99.toFixed(0)}ms.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `IOPS utilization is ${(values.iopsUtil * 100).toFixed(0)}%; throughput utilization is ${(values.bwUtil * 100).toFixed(0)}%. The larger one is the limit that binds.`,
      `${Math.round(values.totalIops).toLocaleString()} IOPS at ${values.ioSizeKb.toFixed(0)} KB with ${values.writeAmplification.toFixed(2)}x write amplification needs ${values.mbps.toFixed(0)} MB/s.`,
      `Queue depth is ${values.queueDepth.toFixed(1)} and I/O p99 is ${values.p99.toFixed(0)}ms. A deep queue turns a fast device into a slow path.`,
      `fsync p99 is ${values.fsyncP99.toFixed(0)}ms. That is the durability cost the application pays for each commit, not just a slow read.`,
    ];
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
    description: "Modest mixed traffic with short fsync waits.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Write-heavy traffic pushes queue depth and fsync latency to the warning line.",
    tone: "warn",
    params: defaults({ iopsDemand: 4_000, writeShare: 70, fsyncRate: 200, ioSizeKb: 16 }),
  },
  {
    id: "failure",
    label: "Write storm",
    description: "High IOPS, 32 KB writes, and 1,500 fsync/s saturate both device limits.",
    tone: "crit",
    params: defaults({ iopsDemand: 5_000, writeShare: 80, fsyncRate: 1_500, ioSizeKb: 32 }),
  },
  {
    id: "recovery",
    label: "Smaller I/O, fewer commits",
    description: "Lower demand, smaller writes, and fewer fsyncs bring the queue back down.",
    tone: "ok",
    params: defaults({ iopsDemand: 2_500, writeShare: 50, fsyncRate: 100, ioSizeKb: 16 }),
  },
];

const experiment: Experiment = {
  id: "predict-disk-limit",
  title: "Predict which device limit binds",
  simId: "linux-disk-io",
  question:
    "The volume reports 100% utilization, but IOPS demand is only 68% of the provisioned IOPS limit. Average I/O is 64 KB. Which limit is actually saturated?",
  prediction: {
    options: [
      { id: "iops", label: "The IOPS limit" },
      { id: "bandwidth", label: "The throughput limit" },
      { id: "fsync", label: "The fsync rate" },
      { id: "cpu", label: "The host CPU" },
    ],
    correctOptionId: "bandwidth",
    explanation:
      "IOPS and throughput are separate limits. At 64 KB per operation, the same IOPS rate moves four times the bytes of 16 KB I/O. The device reaches its 125 MB/s throughput limit while the IOPS counter is still below its own ceiling. Adding IOPS would not help; the workload needs more bandwidth or smaller requests.",
  },
  setup: defaults({ iopsDemand: 4_000, writeShare: 70, fsyncRate: 200, ioSizeKb: 64 }),
  runFor: 20,
  observe: [
    "Device utilization is pinned at 100% while IOPS utilization stays below the warning line.",
    "Throughput demand is 315 MB/s against the device's 125 MB/s limit.",
    "Queue depth reaches its ceiling and I/O p99 spikes.",
    "Shrinking the average I/O to 16 KB removes the bandwidth pressure without adding IOPS.",
  ],
  explain:
    "A volume has at least two independent limits: operations per second and bytes per second. A workload with small random I/O usually hits IOPS first. A workload with large I/O or high write amplification can hit throughput first. Queue depth is the consequence, not the cause. Read both utilization numbers before buying more of either.",
  fix: defaults({ iopsDemand: 2_500, writeShare: 50, fsyncRate: 100, ioSizeKb: 16 }),
  debrief:
    "The fix reduced demand, request size, and fsync rate together. The queue fell and fsync p99 returned below the warning line. In production, the cheapest first move is often to understand the I/O size and write amplification; provisioning more IOPS on a bandwidth-bound volume spends money without removing the queue.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A block device has several limits that look similar on a dashboard and behave differently under load. IOPS is how many operations it can complete per second. Throughput is how many bytes per second it can move. Queue depth is how many requests are in flight. Latency is how long one request waits, and it rises when the queue is deeper than the device can drain. A volume can be at 100% utilization because it is busy, because it is queueing, or because the host is waiting on it.",
  },
  {
    type: "p",
    text: "fsync adds a durability requirement. A normal write may sit in the page cache and reach the device later. fsync waits until the data is persistent, so every fsync inherits the device's queueing delay. Write amplification makes this worse: a small logical write can become a larger journal write plus metadata. On a network volume, the provisioned IOPS and throughput limits are separate, and either one can bind first.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it does", "Pressure signal"],
    rows: [
      ["Application write", "Issues logical reads and writes", "Request size and fsync rate"],
      ["Page cache and journal", "Buffers writes and commits metadata", "Write amplification and dirty pages"],
      ["Block layer", "Merges, schedules, and queues requests", "Queue depth"],
      ["Volume", "Serves operations at its IOPS and bandwidth limits", "IOPS, throughput, await, and %util"],
    ],
  },
  {
    type: "p",
    text: "The path is application write, page cache, filesystem journal, block layer queue, and the device. The block layer merges and schedules requests. The device serves them at its IOPS and bandwidth limits. If the application calls fsync, it waits for the whole durable path, including the journal commit and the device flush. iowait is the CPU time spent idle while those tasks wait; it is a symptom, not a cause.",
  },
  {
    type: "p",
    text: "This model uses an illustrative device with 6,000 IOPS and 125 MB/s, a queue limit of 32, and a 0.4 ms base service time. Those are teaching values, not a specification of any EBS volume type. The relationship between IOPS, bandwidth, queue depth, and fsync latency is the lesson; read the provisioned limits of your own volume before sizing.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "IOPS utilization and throughput utilization: two limits that must be compared separately.",
      "Queue depth: requests waiting for the device, and the first sign of saturation.",
      "I/O p99 and fsync p99: the tail the application experiences, not the device average.",
      "Write amplification: the multiplier between logical writes and device traffic.",
      "I/O wait: CPU idle while storage is the constraint.",
    ],
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it hides"],
    rows: [
      ["IOPS", "Operations per second", "Bytes moved per operation"],
      ["Throughput", "Bytes per second", "How many operations that took"],
      ["Queue depth", "Requests in flight", "Whether the queue is growing or draining"],
      ["await", "Average wait per request", "The tail and the queue's direction"],
      ["%util", "Device busy time", "Whether the device is queueing or just busy"],
      ["fsync p99", "Durability latency", "The individual fsync count and write size"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Peak. Compare IOPS utilization with throughput utilization before changing anything. Apply Write storm and watch fsync p99 and queue depth move together. Then shrink the I/O size and lower the fsync rate to see which change removes the queue.",
  },
  { type: "sim", simId: "linux-disk-io" },
  { type: "experiment", experimentId: "predict-disk-limit" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The application generated more bytes than the device could move per second, even though the operation count was below the IOPS limit. The block queue filled, queue depth reached its ceiling, and every request waited behind the backlog. fsync inherited that wait because it cannot return until the device commits the write.",
  },
  {
    type: "p",
    text: "The recovery lowered demand, reduced the average I/O size, and cut the fsync rate. Each change attacked a different part of the same queue. Adding IOPS alone would not have helped the bandwidth-bound case, and adding bandwidth alone would not have helped a small-random-IO workload. The first step is always to identify which limit binds.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "iostat -x: r/s and w/s for operations, rkB/s and wkB/s for bandwidth, aqu-sz for queue depth, await for latency, and %util for busy time.",
      "Cloud volume metrics: provisioned and consumed IOPS, throughput, queue length, and burst balance where the volume type has one.",
      "Application metrics: fsync or commit p99, write size, write amplification, and the number of durable commits per request.",
      "Logs: commit stalls, journal waits, and timeouts that line up with write bursts.",
      "Traces: a database commit or file write span growing while CPU and network stay normal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare IOPS utilization with throughput utilization. Then check queue depth and await. If fsync is in the path, graph fsync p99 separately from read latency; a durable write pays for the device queue twice.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the limit: IOPS, throughput, queue depth, or a single hot volume.",
      "Check the I/O size and write amplification before adding capacity.",
      "Reduce fsync frequency with group commit or batching only if the durability contract allows it.",
      "Move cold or batch I/O off the latency-sensitive volume.",
      "Add the resource that is actually short, then re-check queue depth and fsync p99.",
      "Verify the tail at peak, not the average after the incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More IOPS helps small random I/O and does nothing for a bandwidth-bound workload.",
      "More throughput helps large I/O and does nothing for an IOPS-bound queue.",
      "Batching fsyncs improves throughput and widens the window of acknowledged-but-not-durable writes.",
      "Caching absorbs reads and can make writes look fast until the cache must flush or the device stalls.",
      "A larger queue can absorb bursts and increases latency for every request behind it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-iostat",
    question:
      "iostat shows 100% utilization, await 300ms, and aqu-sz 32. Is the device slow or overloaded?",
    difficulty: 2,
    hints: [
      "Utilization says busy, not necessarily slow.",
      "Queue depth and await tell you about waiting.",
    ],
    answer:
      "It is overloaded until proven otherwise. A queue depth of 32 with 300ms await means requests are waiting behind other requests, not necessarily that the media is slow. I would compare the demand with the provisioned IOPS and throughput, check the I/O size, and look for write amplification. If the device is within its limits and the queue is still deep, then I would investigate the device or the path. The fix depends on which limit binds.",
    followUps: [
      "How would you tell a slow device from a deep queue?",
      "What would you check if utilization is 100% but await is low?",
      "How does I/O size change the answer?",
    ],
    redFlags: [
      "Calls the device slow from %util alone.",
      "Adds IOPS without checking bandwidth.",
      "Ignores queue depth.",
    ],
    rubric: [
      "Separates busy from overloaded.",
      "Reads queue depth and await together.",
      "Checks both IOPS and throughput.",
      "Names the confirming evidence.",
    ],
  },
  {
    id: "fsync-cost",
    question:
      "Why does fsync latency spike when the device is only at 70% IOPS utilization?",
    difficulty: 3,
    hints: [
      "fsync waits for a durable commit, not just a cache write.",
      "Queueing delay affects every request in the queue.",
    ],
    answer:
      "fsync waits for the write to become durable, so it sits behind the device queue and any journal commit ahead of it. At 70% average utilization, bursts can still fill the queue and the tail waits. Write amplification can make each fsync larger than the application write. I would check fsync p99 against queue depth and write size, and compare the fsync rate with the device's capability. Adding a cache above the device does not make fsync durable.",
    followUps: [
      "How would group commit change the fsync rate?",
      "What does fdatasync avoid that fsync does not?",
      "How would you measure write amplification?",
    ],
    redFlags: [
      "Assumes fsync is just another write.",
      "Blames the application without checking the queue.",
      "Suggests acknowledging before the commit.",
    ],
    rubric: [
      "Explains durability semantics.",
      "Links fsync to queueing and journaling.",
      "Names the measurement.",
      "Respects the durability contract.",
    ],
  },
  {
    id: "iops-vs-bandwidth",
    question:
      "A workload moves 80 MB/s at 2,000 IOPS. The volume allows 6,000 IOPS and 125 MB/s. Which limit will bind first if the I/O size doubles?",
    difficulty: 3,
    hints: [
      "Doubling the I/O size doubles the bytes per operation.",
      "IOPS stays the same if the operation count does not change.",
    ],
    answer:
      "Throughput binds first. At 2,000 IOPS and 40 KB per operation the workload already moves 80 MB/s; doubling the size to 80 KB would need 160 MB/s, above the 125 MB/s limit, while IOPS remains 2,000 against a 6,000 limit. The queue would grow because the device cannot drain bytes fast enough. The fix is more bandwidth, smaller I/O, or less write amplification, not more IOPS.",
    followUps: [
      "What if the workload also increased to 5,000 IOPS?",
      "How does sequential versus random I/O change the answer?",
      "Which cloud volume metric would you graph?",
    ],
    redFlags: [
      "Compares IOPS only.",
      "Assumes throughput scales with IOPS.",
      "Ignores write amplification.",
    ],
    rubric: [
      "Computes bytes per second.",
      "Identifies throughput as the limit.",
      "Proposes a matching fix.",
      "Notes the queue consequence.",
    ],
  },
  {
    id: "batch-isolation",
    question:
      "A nightly batch job on the same volume doubles p99 for the online service. How do you isolate the impact without buying a bigger volume?",
    difficulty: 3,
    hints: [
      "The batch and the service compete for the same queue.",
      "Isolation can be logical or physical.",
    ],
    answer:
      "I would first separate the workloads: move the batch to its own volume, or cap its IOPS and concurrency with cgroup I/O controls or an application-level rate limit. I would schedule it outside the peak and reduce its I/O size or write amplification if possible. If the volume must be shared, I would reserve headroom for the online path and monitor queue depth by workload. Buying a bigger volume treats the symptom; isolation protects the latency-sensitive path.",
    followUps: [
      "How would you measure the batch's contribution to the queue?",
      "What would you do if the batch cannot move?",
      "How does this relate to bulkheads?",
    ],
    redFlags: [
      "Runs the batch at full speed and hopes.",
      "Only buys a bigger volume.",
      "Ignores write amplification.",
    ],
    rubric: [
      "Separates the workloads.",
      "Caps or schedules the batch.",
      "Protects the online path.",
      "Measures the result.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show IOPS, throughput, queue depth, await, and %util per volume.",
      "fsync or commit latency is graphed separately from read latency.",
      "The provisioned IOPS and throughput limits are documented for each volume.",
      "Batch workloads have their own volume or a bounded I/O budget.",
      "Average I/O size and write amplification are known for the write path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare IOPS utilization with throughput utilization.",
      "Check queue depth and await before calling the device slow.",
      "Check whether fsync is in the request path.",
      "Look for a batch job or a write burst that started with the incident.",
      "After any change, watch the tail and the queue, not just the average.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record which limit bound and why.",
      "Reduce write amplification or I/O size if that was the cause.",
      "Add headroom for peak bursts, not just the average.",
      "Re-test the write path at peak with the new limits.",
    ],
  },
];

const references = [
  {
    title: "Block layer statistics",
    url: "https://docs.kernel.org/block/stat.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "How the kernel accounts for block I/O and queue activity.",
  },
  {
    title: "iostat(1)",
    url: "https://man7.org/linux/man-pages/man1/iostat.1.html",
    publisher: "Linux man-pages",
    kind: "docs" as const,
    note: "IOPS, throughput, queue depth, await, and utilization columns.",
  },
  {
    title: "Amazon EBS volume types",
    url: "https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Provisioned IOPS and throughput are separate limits on EBS volumes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "linux-disk-io": {
      model: linuxDiskIoModel,
      presets,
      instructions:
        "Start healthy, then raise IOPS demand and I/O size separately. Compare IOPS utilization with throughput utilization and watch queue depth and fsync p99.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative device: 6,000 IOPS, 125 MB/s, queue limit 32. Not a specification of a specific EBS volume type.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-linux-cpu", "foundations-linux-memory", "observability-victoriametrics-architecture"],
};
