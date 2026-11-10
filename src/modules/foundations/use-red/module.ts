import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DISK_IOPS = 12_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the API. Red sees this rate directly.",
    format: "rps" as const,
  },
  {
    id: "writeShare",
    label: "Write share",
    min: 5,
    max: 60,
    step: 1,
    value: 20,
    unit: "%",
    group: "Traffic",
    help: "Share of requests that produce a database write. Writes cost more disk I/O than cached reads.",
    format: "percent" as const,
  },
  {
    id: "batchMbps",
    label: "Background batch writes",
    min: 0,
    max: 600,
    step: 20,
    value: 0,
    unit: " MB/s",
    group: "Resource",
    help: "Bulk copy job writing to the same volume as the database. This load is invisible to RED.",
    format: "number" as const,
  },
  {
    id: "cacheHit",
    label: "Read cache hit rate",
    min: 50,
    max: 98,
    step: 1,
    value: 90,
    unit: "%",
    group: "Resource",
    help: "Reads absorbed before the database. Higher values reduce read I/O but do nothing for writes.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  writeShare: number;
  batchMbps: number;
  cacheHit: number;
  readQps: number;
  writeQps: number;
  dbIops: number;
  diskUtil: number;
  diskQueue: number;
  diskLatency: number;
  requestP99: number;
  errorRate: number;
  cacheQps: number;
  appUtil: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 8_000));
  const writeShare = clamp(num(p, "writeShare", 20) / 100, 0.01, 0.9);
  const batchMbps = Math.max(0, num(p, "batchMbps", 0));
  const cacheHit = clamp(num(p, "cacheHit", 90) / 100, 0, 0.99);
  const readQps = requestRate * (1 - cacheHit);
  const writeQps = requestRate * writeShare;
  const dbIops = readQps * 0.6 + writeQps * 3 + batchMbps * 8;
  const diskUtil = (dbIops / DISK_IOPS) * 100;
  const u = diskUtil / 100;
  const diskQueue = u <= 0.85 ? u * 4 : 4 + (u - 0.85) * 1_200;
  const diskLatency =
    u < 0.85
      ? 0.8 + 8 * u ** 6
      : u < 1
        ? 3.8 + (u - 0.85) * 400
        : 63.8 + (u - 1) * 120;
  return {
    requestRate,
    writeShare,
    batchMbps,
    cacheHit,
    readQps,
    writeQps,
    dbIops,
    diskUtil,
    diskQueue,
    diskLatency,
    requestP99: 65 + Math.max(0, u - 0.75) * 90 + writeShare * 20,
    errorRate: Math.max(0, u - 2) * 5,
    cacheQps: requestRate * cacheHit,
    appUtil: requestRate / 30_000,
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 0.9) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.6);
  const entries: [string, number, number][] = [
    ["disk-util", values.diskUtil, 2],
    ["request-p99", values.requestP99, 3],
    ["disk-queue", values.diskQueue, 4],
    ["disk-latency", values.diskLatency, 0.4],
    ["error-rate", values.errorRate, 0.05],
    ["request-rate", values.requestRate, 80],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2 + value) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const diskHealth = healthFor(v.diskUtil / 100);
  const dbHealth = v.diskUtil >= 130 ? "crit" : v.diskUtil >= 90 ? "warn" : "ok";
  const appHealth = v.requestRate >= 27_000 ? "warn" : "ok";
  const appUtil = clamp(v.appUtil);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "request path",
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Edge load balancer",
        kind: "lb",
        health: "ok",
        utilization: clamp(v.requestRate / 80_000),
        throughput: v.requestRate,
        sublabel: `${Math.round(v.requestRate).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "app-1",
        label: "API task 1",
        kind: "service",
        health: appHealth,
        utilization: appUtil,
        throughput: v.requestRate / 3,
        sublabel: `${Math.round(v.writeShare * 100)}% writes`,
        meta: { view: "flow" },
      },
      {
        id: "app-2",
        label: "API task 2",
        kind: "service",
        health: appHealth,
        utilization: appUtil,
        throughput: v.requestRate / 3,
        sublabel: "same deployment",
        meta: { view: "detail" },
      },
      {
        id: "app-3",
        label: "API task 3",
        kind: "service",
        health: appHealth,
        utilization: appUtil,
        throughput: v.requestRate / 3,
        sublabel: "same deployment",
        meta: { view: "detail" },
      },
      {
        id: "redis",
        label: "Read cache",
        kind: "cache",
        health: healthFor(v.cacheQps / 50_000),
        utilization: clamp(v.cacheQps / 50_000),
        throughput: v.cacheQps,
        sublabel: `${Math.round(v.cacheHit * 100)}% hit rate`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Postgres primary",
        kind: "db",
        health: dbHealth,
        utilization: clamp(v.dbIops / DISK_IOPS),
        sublabel: `${Math.round(v.writeQps).toLocaleString()} writes/s`,
        meta: { view: "flow" },
      },
      {
        id: "replica",
        label: "Postgres replica",
        kind: "db",
        role: "replica",
        health: "ok",
        utilization: clamp(v.readQps / 4_000),
        throughput: v.readQps,
        sublabel: "read-only",
        meta: { view: "detail" },
      },
      {
        id: "disk",
        label: "Database volume",
        kind: "storage",
        health: diskHealth,
        utilization: clamp(v.diskUtil / 100),
        capacity: DISK_IOPS,
        sublabel: `${Math.round(v.diskUtil)}% of ${DISK_IOPS.toLocaleString()} IOPS`,
        detail: `Illustrative ${DISK_IOPS.toLocaleString()} IOPS volume. The write path appends to a buffer and flushes asynchronously, so request duration does not include the flush.`,
        meta: { view: "flow" },
      },
      {
        id: "batch",
        label: "Batch copy job",
        kind: "worker",
        health: v.batchMbps >= 400 ? "warn" : "ok",
        utilization: clamp(v.batchMbps / 600),
        sublabel: `${Math.round(v.batchMbps)} MB/s`,
        meta: { view: "detail" },
      },
      {
        id: "backup",
        label: "Backup agent",
        kind: "worker",
        health: "ok",
        utilization: 0.1,
        sublabel: "nightly snapshot",
        meta: { view: "detail" },
      },
      {
        id: "object-store",
        label: "Backup bucket",
        kind: "storage",
        health: "ok",
        utilization: 0.2,
        sublabel: "separate volume",
        meta: { view: "detail" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", 0.8),
      edge("lb-app", "lb", "app-1", 0.8, appHealth),
      edge("app-redis", "app-1", "redis", v.cacheHit, healthFor(v.cacheQps / 50_000)),
      edge("app-db", "app-1", "db", v.writeShare, dbHealth),
      edge("db-disk", "db", "disk", clamp(v.dbIops / DISK_IOPS), diskHealth),
      edge("batch-disk", "batch", "disk", clamp(v.batchMbps / 600), diskHealth),
    ],
    metrics: [
      metric("disk-util", "Disk utilization", v.diskUtil, "%", 70, 90, "percent"),
      metric("request-p99", "Request p99", v.requestP99, "ms", 300, 450, "ms"),
      metric("disk-queue", "Disk queue", v.diskQueue, " ops", 50, 250, "count"),
      metric("disk-latency", "Disk latency", v.diskLatency, "ms", 20, 80, "ms"),
      metric("error-rate", "Request errors", v.errorRate, "%", 1, 5, "percent"),
      metric("request-rate", "Request rate", v.requestRate, " rps", undefined, undefined, "rps"),
      metric("cache-hit", "Cache hit rate", v.cacheHit * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), batchHidden: 0 },
    summary: `${Math.round(v.requestRate).toLocaleString()} rps, ${v.requestP99.toFixed(0)}ms p99. Disk at ${Math.round(v.diskUtil)}% with ${Math.round(v.diskQueue)} queued I/O.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "disk-util",
    metricId: "disk-util",
    warn: 70,
    crit: 90,
    title: "The database volume is saturated",
    cause:
      "The volume is doing more I/O than it can sustain. Buffered writes keep the request path calm, so RED sees a healthy service while the device queue grows.",
    fix:
      "Find the workload driving the IOPS. Throttle or move the batch writer, reduce write amplification, then confirm disk queue and latency fall. Adding API replicas adds more writes.",
    checkFirst: [
      "Split volume IOPS by workload: database, batch, backup, and sidecars.",
      "Check disk queue depth and device latency, not only the utilization percentage.",
      "Check whether writes are acknowledged before they reach the disk.",
    ],
  },
  {
    id: "disk-queue",
    metricId: "disk-queue",
    warn: 50,
    crit: 250,
    title: "I/O requests are waiting in the device queue",
    cause:
      "The volume cannot keep up with the offered I/O. Queue depth rises before request latency does because the application is buffering writes.",
    fix:
      "Cap concurrent flushes and batch writes. If the queue does not drain, provision more IOPS or move the batch workload to a separate volume.",
    checkFirst: [
      "Compare queue depth with write throughput over the same window.",
      "Check for a batch job or backup that started before the queue rose.",
      "Check whether retries are adding duplicate writes.",
    ],
  },
  {
    id: "disk-latency",
    metricId: "disk-latency",
    warn: 20,
    crit: 80,
    title: "Device latency is climbing",
    cause:
      "Queueing at the block device increases the time each flush takes. The application can hide this until its write buffer fills.",
    fix:
      "Reduce write concurrency, move the batch load, or raise the volume's provisioned IOPS. Measure the flush lag at the application as well as device latency.",
    checkFirst: [
      "Check queue depth against device latency.",
      "Check the volume's burst balance or provisioned IOPS ceiling.",
      "Check application write-buffer depth and flush age.",
    ],
  },
  {
    id: "request-p99",
    metricId: "request-p99",
    warn: 300,
    crit: 450,
    title: "The request path has started to wait on writes",
    cause:
      "The write buffer is nearly full, so some requests now wait for a flush. RED reflects the problem only after the resource has been saturated for a while.",
    fix:
      "Protect the request path with a bounded write buffer, shed or queue low-priority writes, and separate batch I/O from the database volume.",
    checkFirst: [
      "Compare the p99 rise with write-buffer depth.",
      "Check whether writes and reads share the same volume.",
      "Check whether request retries are duplicating writes.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Write errors are reaching clients",
    cause:
      "The buffer is exhausted and the disk cannot absorb the flush. Requests now fail after the resource problem has propagated to the request path.",
    fix:
      "Shed or queue writes with a clear response, stop retrying into a saturated volume, and restore disk headroom before resuming normal traffic.",
    checkFirst: [
      "Check write-buffer exhaustion and flush errors.",
      "Check for retry storms against the same volume.",
      "Check whether reads are still served from cache.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const useRedModel: SimModel = {
  id: "foundations-use-red",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    const key = JSON.stringify(p);
    const changed = frame.flags.paramsKey !== key;
    next.flags = { ...frame.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (changed && frame.t <= 0.11) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = frame.series;
    }
    const jitter = rng.between(-0.015, 0.015);
    next.metrics = next.metrics.map((item) =>
      item.id === "request-p99" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.diskUtil >= 90 && values.requestP99 < 300 && values.errorRate < 1 && frame.flags.batchHidden !== 1) {
      pushEvent(next, {
        id: "disk-hidden",
        at: frame.t,
        severity: "warn",
        title: "Saturated disk under a healthy RED dashboard",
        detail: `${Math.round(values.diskUtil)}% disk utilization and ${Math.round(values.diskQueue)} queued I/O, while request p99 is ${values.requestP99.toFixed(0)}ms and errors are ${values.errorRate.toFixed(1)}%.`,
        nodeId: "disk",
        metricId: "disk-util",
      });
      next.flags.batchHidden = 1;
    }
    if (values.diskUtil < 70) next.flags.batchHidden = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${Math.round(values.requestRate).toLocaleString()} rps, ${values.requestP99.toFixed(0)}ms p99. Disk at ${Math.round(values.diskUtil)}% with ${Math.round(values.diskQueue)} queued I/O.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    items.push(`RED: ${Math.round(v.requestRate).toLocaleString()} rps, ${v.errorRate.toFixed(1)}% errors, ${v.requestP99.toFixed(0)}ms p99.`);
    items.push(`USE: disk ${Math.round(v.diskUtil)}% utilized, ${Math.round(v.diskQueue)} queued I/O, ${v.diskLatency.toFixed(1)}ms device latency.`);
    if (v.diskUtil >= 90 && v.requestP99 < 300) {
      items.push("The request path is buffering writes, so RED is not a complete view of this failure.");
    }
    items.push(`The batch writer contributes ${Math.round(v.batchMbps)} MB/s to the same volume as ${Math.round(v.writeQps).toLocaleString()} database writes/s.`);
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
    description: "Modest traffic, a warm cache, and no background batch job.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Peak traffic plus a small batch job; the disk is saturated but not critical.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, batchMbps: 80, cacheHit: 90 }),
  },
  {
    id: "failure",
    label: "Hidden disk",
    description: "A 500 MB/s batch copy saturates the database volume while RED stays green.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, batchMbps: 500, cacheHit: 80 }),
  },
  {
    id: "cache-raised",
    label: "Raise cache hit",
    description: "The obvious request-path fix: more cache hits. The disk remains saturated because writes still hit it.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, batchMbps: 500, cacheHit: 98 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Throttle the batch writer and restore cache coverage; disk utilization returns to normal.",
    tone: "ok",
    params: defaults({ requestRate: 12_000, batchMbps: 0, cacheHit: 90 }),
  },
];

const experiment: Experiment = {
  id: "predict-lens",
  title: "Predict which lens sees the problem first",
  simId: "use-red",
  question:
    "The batch writer is running at 500 MB/s. Which signal crosses its threshold before request latency or errors do?",
  prediction: {
    options: [
      { id: "disk", label: "Disk utilization and queue depth" },
      { id: "errors", label: "Request error rate" },
      { id: "p99", label: "Request p99" },
      { id: "rate", label: "Request rate" },
    ],
    correctOptionId: "disk",
    explanation:
      "The database writes into a buffer and flushes asynchronously. RED measures the request path, which still returns quickly. USE measures the disk, where utilization and queue depth are already at the limit.",
  },
  setup: defaults({ requestRate: 12_000, batchMbps: 500, cacheHit: 80 }),
  runFor: 20,
  observe: [
    "Disk utilization passes 100% and the device queue sits near its limit.",
    "Request p99 stays near 100ms, below its 300ms warning line.",
    "Request errors stay at zero while the write buffer has not filled.",
    "The API and cache nodes look healthy; the database volume is the critical node.",
  ],
  explain:
    "A request-path dashboard cannot see work that the application defers. The batch writer consumes the same IOPS as the database flush, so the resource is saturated even though every request completes quickly. USE finds that state because it asks about the device, not about the request.",
  fix: defaults({ requestRate: 12_000, batchMbps: 0, cacheHit: 90 }),
  debrief:
    "The recovery removes the batch load from the database volume and restores enough cache coverage to keep reads off the disk. The request path was never the root cause; it was the last place the failure would appear. That is why the lens choice matters before the incident, not during it.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "USE and RED are two checklists for reading a distributed system. USE stands for utilization, saturation, and errors. It is applied to a resource such as a CPU, a disk, a network interface, or a connection pool. RED stands for rate, errors, and duration. It is applied to a service or a request path. The two acronyms come from different traditions, but they answer one question together: is the problem in the work, or in the machinery doing the work?",
  },
  {
    type: "p",
    text: "Utilization is the share of a resource's capacity in use. Saturation is the work waiting because the resource cannot keep up: a run queue, a device queue, a connection wait. Errors are the resource's reported failures. RED's rate is requests per second, errors are the share that fail, and duration is how long the successful and failed requests take. A resource can be saturated while the service still looks fast, because the service may be buffering or deferring the work.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "p",
    text: "USE sits underneath the request path, one layer per resource. RED sits on the request path, at the service and at its callers. A complete first response uses both: RED tells you whether users are affected, and USE tells you which resource is carrying the load. The lenses are not alternatives. They are two views of the same system at different layers.",
  },
  {
    type: "compare",
    leftTitle: "USE: resources",
    rightTitle: "RED: request path",
    rows: [
      { label: "Question", left: "Is a resource exhausted?", right: "Is the service sick?" },
      { label: "Signals", left: "Utilization, saturation, errors", right: "Rate, errors, duration" },
      { label: "Scope", left: "CPU, disk, memory, network, pools", right: "Service, endpoint, dependency" },
      { label: "Blind spot", left: "Does not say which user request is slow", right: "Cannot see deferred or buffered work" },
    ],
  },
  {
    type: "p",
    text: "This module models a 12-node API path: client, load balancer, three API tasks, a read cache, a PostgreSQL primary and replica, the database volume, a batch copy job, a backup agent, and a backup bucket. The disk's IOPS ceiling, the write amplification, and the conversion from megabytes per second to IOPS are illustrative teaching values. They are not an EBS capacity guarantee. The shape of the failure is the lesson: a saturated resource hidden behind a healthy request path.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "RED panel: request rate, error rate, and p99 duration for the API.",
      "USE panel: disk utilization, device queue depth, and device latency.",
      "The database volume node, which turns critical while the API nodes stay healthy.",
      "A cache-hit control that reduces read I/O but leaves write I/O untouched.",
      "A batch-write control that adds resource load without adding request traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and note the RED and USE values. Apply Hidden disk: p99 stays near 100ms while disk utilization passes 100%. Then apply Raise cache hit and watch the disk stay saturated. Use Recovery only after you can explain why caching was the wrong first move.",
  },
  { type: "sim", simId: "use-red" },
  {
    type: "table",
    headers: ["Signal", "Lens", "What it proves", "What it can miss"],
    rows: [
      ["Disk utilization 105%", "USE", "The volume has more work than capacity", "Which request or job is waiting"],
      ["Disk queue 247", "USE", "Work is waiting for the device", "Whether the wait reaches users"],
      ["Request p99 96ms", "RED", "The request path is still within its SLO", "Deferred writes and buffer growth"],
      ["Request errors 0%", "RED", "No request has failed yet", "A buffer that is about to fill"],
    ],
  },
  {
    type: "p",
    text: "The practical rule is not to choose one lens forever. Start with the symptom: a user-facing symptom belongs to RED, and a capacity or host symptom belongs to USE. Then cross the boundary deliberately. If RED is green and users are unhappy, look below the request path. If USE is green and requests are slow, look at the path: a dependency, a queue, or a retry loop is doing the damage.",
  },
  { type: "experiment", experimentId: "predict-lens" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The batch copy job wrote to the same volume as the database. Disk utilization passed 100% and the device queue filled. The API still returned in about 100ms because writes were appended to a buffer and flushed asynchronously. RED stayed green: rate was steady, errors were zero, and duration was below its SLO. USE was the only lens that showed the saturated resource.",
  },
  {
    type: "p",
    text: "Raising the cache hit rate reduced read I/O, but the disk was saturated by writes. That is the trap in the module: the request-path fix looked reasonable and did not touch the cause. Removing the batch load from the volume restored disk headroom. Only then did the USE and RED views agree that the system was healthy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch EBS: `VolumeQueueLength`, `VolumeReadOps`, `VolumeWriteOps`, `VolumeThroughputPercentage`, and `BurstBalance` where the volume type exposes it.",
      "Linux: `node_disk_io_time_seconds_total`, `node_disk_io_time_weighted_seconds_total`, and per-device await from `iostat`.",
      "Datadog: `system.disk.io_time`, `system.io.await`, and `system.io.util`, grouped by device.",
      "Application: write-buffer depth, flush age, and flush error counters, which explain why RED has not moved yet.",
      "Traces: the API span and the cache span are normal while the database commit or flush span is slow.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare RED and USE over the same window. If RED is green and the disk is saturated, find which workload owns the IOPS. Split database, batch, backup, and sidecar I/O by device before changing capacity. Then check buffer depth and flush age to see how much time remains before the request path notices.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the disk is saturated with utilization, queue depth, and device latency, not with an average CPU graph.",
      "Attribute the IOPS: database writes, batch copy, backup, and any sidecar sharing the device.",
      "Protect the request path with a bounded write buffer and a clear failure response if the buffer fills.",
      "Move batch and backup I/O to a separate volume or throttle it to leave database headroom.",
      "Reduce write amplification where possible, then verify that disk queue and flush age fall.",
      "Recheck RED after USE recovers; a green resource does not prove the request path is healthy.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A separate batch volume removes interference but adds cost and another lifecycle to manage.",
      "Throttling the batch job protects the database but extends the batch window and may miss a deadline.",
      "More provisioned IOPS buys headroom but does not fix a workload that writes more than it needs to.",
      "A bounded write buffer protects latency but can reject writes earlier, which is a product decision.",
      "RED-only dashboards are cheap to read but cannot see a resource that the request path is hiding.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-lens",
    question:
      "A service is slow and CPU is at 40%. Do you start with USE or RED, and what does each tell you?",
    difficulty: 1,
    hints: [
      "Start from the user-facing symptom.",
      "One lens shows the request path; the other shows the resources under it.",
    ],
    answer:
      "I start with RED because the symptom is user-facing: rate, errors, and duration tell me whether the service is failing broadly, which endpoints are slow, and whether the problem is a dependency. CPU at 40% is a USE data point but not a diagnosis. If RED shows one endpoint with high duration and no errors, I would follow that endpoint's dependency path and then use USE on the dependency: utilization, saturation, and errors for its CPU, disk, pool, or network. If RED is healthy and users still complain, I would go straight to USE because the request path is deferring or hiding the work.",
    followUps: [
      "What if RED shows errors only on one endpoint?",
      "Which USE resource would you check first for a database dependency?",
      "What would make you distrust the CPU number?",
    ],
    redFlags: [
      "Chooses a lens without naming the symptom.",
      "Treats CPU as a complete diagnosis.",
      "Ignores saturation and errors.",
    ],
    rubric: [
      "Starts from the user-facing signal.",
      "Names the three RED signals.",
      "Moves to USE for the dependency.",
      "Explains what would change the plan.",
    ],
  },
  {
    id: "green-red",
    question:
      "RED is green: 5k rps, 0.1% errors, 90ms p99. Users still report stalls. How can that happen?",
    difficulty: 2,
    hints: [
      "The request path can acknowledge work before it is durable.",
      "Look for a buffer, a queue, or an asynchronous flush.",
    ],
    answer:
      "RED measures what the request path observes. If the service acknowledges a write after placing it in a buffer, the request duration excludes the disk flush. The disk can be saturated, the buffer can be growing, and RED can remain green until the buffer fills. I would check USE on the database volume and the write path: disk utilization, queue depth, device latency, buffer depth, and flush age. Then I would correlate the user reports with the flush lag rather than with request latency. The same pattern appears in queues, caches, and any fire-and-forget dependency.",
    followUps: [
      "Which metric would reveal the buffer first?",
      "How would you change the SLO to cover durability?",
      "What is the risk of alerting only on RED?",
    ],
    redFlags: [
      "Says the users must be wrong.",
      "Looks only at request latency.",
      "Adds replicas without checking the write path.",
    ],
    rubric: [
      "Explains deferred work.",
      "Names disk or queue saturation signals.",
      "Proposes buffer or flush-age evidence.",
      "Connects the gap to the SLO.",
    ],
  },
  {
    id: "disk-saturated",
    question:
      "Disk utilization is 100% but request latency is normal. Is the system healthy?",
    difficulty: 2,
    hints: [
      "Utilization is not the same as user impact.",
      "Saturation and queue depth describe the waiting.",
    ],
    answer:
      "No. A saturated resource at 100% utilization has no headroom, and the queue depth and device latency show whether work is waiting. If the request path is buffering writes, normal latency means the buffer is absorbing the delay, not that the disk is keeping up. The system is fragile: a traffic increase, a larger batch, or a slower flush can exhaust the buffer and turn the hidden queue into request errors. I would treat it as a capacity incident, find the workload driving the IOPS, and restore headroom before the request path notices.",
    followUps: [
      "What would you graph to show the risk to a product owner?",
      "How much headroom would you require?",
      "When would 100% utilization be acceptable?",
    ],
    redFlags: [
      "Calls it healthy because latency is normal.",
      "Confuses utilization with saturation.",
      "Waits for errors before acting.",
    ],
    rubric: [
      "Distinguishes utilization from saturation.",
      "Explains the buffer and the risk.",
      "Names queue depth or device latency.",
      "Proposes restoring headroom.",
    ],
  },
  {
    id: "dashboard-coverage",
    question:
      "You own the first-response dashboard. How do you defend its coverage without graphing everything?",
    difficulty: 3,
    hints: [
      "Cover both lenses at the layers that can fail independently.",
      "Every panel should answer a question you would ask at 3 a.m.",
    ],
    answer:
      "I would organize the dashboard by the questions asked during an incident, not by the list of metrics. The top row is RED for the user-facing services: rate, errors, and duration by endpoint or dependency. The next row is USE for the resources those services depend on: utilization, saturation, and errors for CPU, memory, disk, network, and pools. I would add one panel for the boundary that has failed before, such as write-buffer depth or queue age, because that is where the two lenses disagree. I would remove panels that do not change a decision, and I would test the dashboard against past incidents to find blind spots. Coverage is not completeness; it is the ability to answer the next question.",
    followUps: [
      "How do you decide which endpoints get their own RED row?",
      "What would you cut first from an overloaded dashboard?",
      "How do you test coverage before an incident?",
    ],
    redFlags: [
      "Graphs every metric without a question.",
      "Covers only one lens.",
      "Adds panels after each incident without removing any.",
    ],
    rubric: [
      "Organizes by incident questions.",
      "Covers both RED and USE.",
      "Names a known boundary or blind spot.",
      "Describes pruning and testing coverage.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every user-facing service has rate, errors, and duration panels split by meaningful dimension.",
      "Every shared resource has utilization, saturation, and error signals.",
      "Buffered and asynchronous writes expose buffer depth and flush age.",
      "Batch and backup workloads are attributed to the volume they use.",
      "The dashboard has been tested against one past incident with a known blind spot.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "State the symptom in RED terms before opening a resource dashboard.",
      "If RED is green, check USE for deferred work and saturation.",
      "If USE is green, follow the request path through its dependencies and retries.",
      "Find the workload that owns the saturated resource before adding capacity.",
      "Record which lens found the cause and which one missed it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify both lenses at peak, not only the one that found the cause.",
      "Keep the batch or backup isolation that restored headroom, or document why not.",
      "Add the missing saturation or buffer signal to the first-response dashboard.",
      "Re-run the experiment with the production traffic mix.",
    ],
  },
];

const references = [
  {
    title: "Monitoring Distributed Systems",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "The four golden signals and the limits of cause-based alerting.",
  },
  {
    title: "The USE Method",
    url: "https://www.brendangregg.com/usemethod.html",
    publisher: "Brendan Gregg",
    kind: "docs" as const,
    note: "Utilization, saturation, and errors for every resource.",
  },
  {
    title: "AWS Builders' Library",
    url: "https://aws.amazon.com/builders-library/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Instrumentation, load, retries, and failure patterns for distributed services.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "use-red": {
      model: useRedModel,
      presets,
      instructions:
        "Start healthy, then apply Hidden disk. Compare request p99 with disk utilization and queue depth. Try Raise cache hit before you try Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 12,000 IOPS volume and workload conversions are teaching values, not an EBS capacity guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-golden-signals",
    "foundations-littles-law",
    "foundations-percentiles",
    "foundations-coordinated-omission",
  ],
};
