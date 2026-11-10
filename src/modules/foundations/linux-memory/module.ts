import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOST_TOTAL_MB = 32_768;
const HOST_BASELINE_MB = 8_192;
const SWAP_CAP_MB = 1_024;

const params = [
  {
    id: "anonMb",
    label: "Anonymous working set",
    min: 128,
    max: 8_192,
    step: 64,
    value: 800,
    unit: " MB",
    group: "Container",
    help: "Heap, stacks, and anonymous mappings. This memory cannot be reclaimed without swap.",
    format: "number" as const,
  },
  {
    id: "cacheMb",
    label: "Page cache demand",
    min: 0,
    max: 16_384,
    step: 128,
    value: 2_600,
    unit: " MB",
    group: "Container",
    help: "File-backed cache the workload would like to keep. The cgroup charges only what fits under its limit; the rest stays on the host.",
    format: "number" as const,
  },
  {
    id: "limitMb",
    label: "Cgroup memory.max",
    min: 512,
    max: 16_384,
    step: 256,
    value: 4_096,
    unit: " MB",
    group: "Container",
    help: "The container's memory.max. Anonymous memory above this limit plus any cgroup swap allowance causes an OOM kill.",
    format: "number" as const,
  },
  {
    id: "swapEnabled",
    label: "Cgroup swap enabled",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Container",
    help: "1 enables 1,024 MB of cgroup swap. It delays OOM but adds swap-in latency.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  anon: number;
  cache: number;
  limit: number;
  swapEnabled: number;
  swapCap: number;
  effectiveLimit: number;
  anonRatio: number;
  used: number;
  chargedCache: number;
  reclaim: number;
  swapUsed: number;
  oomKills: number;
  pressure: number;
  p99: number;
  hostUsed: number;
  hostPct: number;
}

function compute(p: Params): Computed {
  const anon = Math.max(0, num(p, "anonMb", 800));
  const cache = Math.max(0, num(p, "cacheMb", 2_600));
  const limit = Math.max(128, num(p, "limitMb", 4_096));
  const swapEnabled = num(p, "swapEnabled", 0) >= 1 ? 1 : 0;
  const swapCap = swapEnabled ? SWAP_CAP_MB : 0;
  const effectiveLimit = limit + swapCap;
  const anonRatio = (anon / effectiveLimit) * 100;
  const chargedCache = Math.min(cache, Math.max(0, limit - Math.min(anon, limit)));
  const used = Math.min(100, ((anon + chargedCache) / limit) * 100);
  const reclaim = Math.max(0, cache - chargedCache);
  const swapUsed = swapEnabled ? Math.min(swapCap, Math.max(0, anon - limit * 0.9)) : 0;
  const oomKills = anon > effectiveLimit ? 1 : 0;
  const pressure = clamp(
    Math.max(0, anonRatio - 80) * 3 + (swapUsed / SWAP_CAP_MB) * 40 + (oomKills ? 30 : 0),
    0,
    100,
  );
  const p99 = Math.min(
    3_000,
    4 + Math.max(0, anonRatio - 70) * 1.5 + (swapUsed / SWAP_CAP_MB) * 120 + (oomKills ? 300 : 0),
  );
  const hostUsed = HOST_BASELINE_MB + anon + cache;
  return {
    anon,
    cache,
    limit,
    swapEnabled,
    swapCap,
    effectiveLimit,
    anonRatio,
    used,
    chargedCache,
    reclaim,
    swapUsed,
    oomKills,
    pressure,
    p99,
    hostUsed,
    hostPct: Math.min(100, (hostUsed / HOST_TOTAL_MB) * 100),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.5);
  const seeds: [string, number, number][] = [
    ["anon-ratio", values.anonRatio, 0.2],
    ["memory-pressure", values.pressure, 0.3],
    ["p99", values.p99, 0.4],
    ["cgroup-used", values.used, 0.3],
    ["page-cache", values.chargedCache, 8],
    ["swap-used", values.swapUsed, 0.3],
    ["host-mem", values.hostPct, 0.2],
    ["oom-kills", values.oomKills, 0],
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
  const containerHealth = values.oomKills
    ? "crit"
    : healthFor(values.anonRatio, 85, 100);
  const pressureHealth = healthFor(values.pressure, 20, 50);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "container",
        label: "Application container",
        kind: "service",
        health: containerHealth,
        utilization: clamp(values.anonRatio / 100),
        sublabel: `${Math.round(values.anon)} MB anonymous`,
        detail: `Anonymous ${Math.round(values.anon)} MB against a ${Math.round(values.effectiveLimit)} MB effective limit. Requested page cache ${Math.round(values.cache)} MB; ${Math.round(values.chargedCache)} MB charged and reclaimable.`,
        meta: { view: "flow" },
      },
      {
        id: "cgroup",
        label: "cgroup memory.max",
        kind: "service",
        health: pressureHealth,
        utilization: clamp(values.used / 100),
        sublabel: `${Math.round(values.used)}% used`,
        detail: `memory.current includes page cache. Not charged to this cgroup: ${Math.round(values.reclaim)} MB. Pressure ${values.pressure.toFixed(0)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Page cache",
        kind: "cache",
        health: "ok",
        utilization: clamp(values.chargedCache / Math.max(1, values.limit)),
        sublabel: `${Math.round(values.chargedCache)} MB charged`,
        meta: { view: "flow" },
      },
      {
        id: "swap",
        label: "Swap",
        kind: "storage",
        health: healthFor(values.swapUsed, 256, 768),
        utilization: clamp(values.swapUsed / Math.max(1, values.swapCap)),
        sublabel: `${Math.round(values.swapUsed)} MB used`,
        meta: { view: "flow" },
      },
      {
        id: "host",
        label: "Host",
        kind: "service",
        health: "ok",
        utilization: clamp(values.hostPct / 100),
        sublabel: `${values.hostPct.toFixed(0)}% of 32 GB`,
        detail: `Host memory includes other workloads. A healthy host does not protect a cgroup from its own limit.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("container-cgroup", "container", "cgroup", clamp(values.anon / values.effectiveLimit), containerHealth),
      edge("cache-cgroup", "cache", "cgroup", clamp(values.chargedCache / Math.max(1, values.limit)), "ok"),
      edge("cgroup-host", "cgroup", "host", clamp(values.hostPct / 100), "ok"),
    ],
    metrics: [
      metric("anon-ratio", "Anonymous vs effective limit", values.anonRatio, "%", 85, 100, "percent"),
      metric("memory-pressure", "Memory pressure (anon + swap)", values.pressure, "%", 20, 50, "percent"),
      metric("p99", "Request p99", values.p99, "ms", 50, 200, "ms"),
      metric("cgroup-used", "Cgroup memory used", values.used, "%", undefined, undefined, "percent"),
      metric("page-cache", "Page cache charged", values.chargedCache, " MB", undefined, undefined, "number"),
      metric("swap-used", "Swap used", values.swapUsed, " MB", 256, 768, "number"),
      metric("oom-kills", "OOM kills", values.oomKills, "", 1, 1, "count"),
      metric("host-mem", "Host memory used", values.hostPct, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Anonymous ${values.anonRatio.toFixed(0)}% of the effective limit; ${Math.round(values.chargedCache)} MB charged page cache; ${values.oomKills ? "OOM kill" : "no OOM"}; pressure ${values.pressure.toFixed(0)}%.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "anon-ratio",
    metricId: "anon-ratio",
    warn: 85,
    crit: 100,
    title: "Anonymous memory is at the effective limit",
    cause:
      "Anonymous memory cannot be reclaimed without swap. Page cache may be reclaimed first, but once the anonymous working set reaches memory.max plus memory.swap.max, the cgroup OOM killer runs. The denominator includes both limits so swap does not look like free anonymous capacity.",
    fix: "Reduce the anonymous working set, raise memory.max, or add swap if the latency is acceptable. Dropping page cache does not create durable headroom.",
    checkFirst: [
      "Read memory.current and the anon field in memory.stat, not just the used percentage.",
      "Check memory.max and memory.swap.max for the cgroup.",
      "Check whether the host has free memory; a host-level view can hide a cgroup limit.",
    ],
  },
  {
    id: "memory-pressure",
    metricId: "memory-pressure",
    warn: 20,
    crit: 50,
    title: "Memory pressure is slowing the workload",
    cause:
      "The kernel is reclaiming and compacting memory instead of serving requests, and swap may be absorbing anonymous pages. Pressure rises before an OOM kill and can cost more latency than the memory itself.",
    fix: "Reduce the working set or raise the limit before the pressure turns into an OOM. Check whether page cache thrashing or swap is the source.",
    checkFirst: [
      "Check memory.pressure or /proc/pressure/memory.",
      "Check reclaim activity and swap-in rate.",
      "Check whether the workload's working set grew or the limit shrank.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 50,
    crit: 200,
    title: "Memory pressure is visible in request latency",
    cause:
      "Reclaim, compaction, and swap-in add stalls to the request path. The application may be healthy in CPU terms while memory management dominates latency.",
    fix: "Relieve memory pressure before tuning the application. Reducing the anonymous working set or raising the cgroup limit addresses the cause; restarting the process only resets the clock.",
    checkFirst: [
      "Correlate p99 with memory pressure and reclaim.",
      "Check for swap-in and major page faults.",
      "Check whether a restart temporarily hides the growth.",
    ],
  },
  {
    id: "oom-kills",
    metricId: "oom-kills",
    warn: 1,
    crit: 1,
    title: "The cgroup OOM killer terminated a process",
    cause:
      "Anonymous memory plus unreclaimable kernel memory exceeded the cgroup limit. The kernel selected a process by its OOM score, which is influenced by memory use and oom_score_adj.",
    fix: "Identify the killed process and its anonymous growth. Raise the limit or fix the leak before restarting under the same limit.",
    checkFirst: [
      "Check dmesg or the kernel log for the OOM report and the killed PID.",
      "Check memory.stat anon and the cgroup limit.",
      "Check whether a restart loop is masking a leak.",
    ],
  },
  {
    id: "swap-used",
    metricId: "swap-used",
    warn: 256,
    crit: 768,
    title: "The workload is swapping",
    cause:
      "Anonymous pages were pushed to swap to stay under the limit. Swap avoids an immediate OOM but adds I/O latency to memory access.",
    fix: "Reduce the working set or add memory. Swap is a cushion, not a capacity plan for a latency-sensitive service.",
    checkFirst: [
      "Check swap-in and swap-out rates, not only the swapped total.",
      "Check p99 and major faults on the affected process.",
      "Check whether the swap device itself is saturated.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const linuxMemoryModel: SimModel = {
  id: "foundations-linux-memory",
  visual: "flow",
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
    if (values.oomKills && frame.flags.oomEvent !== 1) {
      pushEvent(next, {
        id: "cgroup-oom",
        at: frame.t,
        severity: "crit",
        title: "Cgroup OOM killer terminated a process",
        detail: `Anonymous memory is ${Math.round(values.anon)} MB against a ${Math.round(values.effectiveLimit)} MB effective limit. ${Math.round(values.chargedCache)} MB of page cache is charged to the cgroup, but reclaiming it cannot bring anonymous memory below the limit.`,
        nodeId: "container",
        metricId: "oom-kills",
      });
      next.flags.oomEvent = 1;
    }
    if (!values.oomKills) next.flags.oomEvent = 0;
    next.flags.paramsKey = key;
    next.summary = `Anonymous ${values.anonRatio.toFixed(0)}% of the effective limit; ${Math.round(values.chargedCache)} MB charged page cache; ${values.oomKills ? "OOM kill" : "no OOM"}; pressure ${values.pressure.toFixed(0)}%.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The cgroup reports ${values.used.toFixed(0)}% used, but ${Math.round(values.chargedCache)} MB of that is charged page cache. The OOM risk comes from ${Math.round(values.anon)} MB of anonymous memory.`,
      `Anonymous memory is ${values.anonRatio.toFixed(0)}% of the ${Math.round(values.effectiveLimit)} MB effective limit. Above 100%, the cgroup OOM killer runs.`,
      `The host is ${values.hostPct.toFixed(0)}% used. A host-level dashboard can look healthy while this cgroup is at its own limit.`,
    ];
    if (values.swapEnabled) {
      items.push(`Swap holds ${Math.round(values.swapUsed)} MB. It delays OOM and adds swap-in latency; it does not make the working set smaller.`);
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
    description: "A small anonymous set with a large, reclaimable page cache.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Cache fills the limit and anonymous memory approaches the hard limit.",
    tone: "warn",
    params: defaults({ anonMb: 1_800, cacheMb: 3_000, limitMb: 2_048 }),
  },
  {
    id: "failure",
    label: "OOM kill",
    description: "Anonymous memory exceeds memory.max; the cgroup OOM killer runs.",
    tone: "crit",
    params: defaults({ anonMb: 2_400, cacheMb: 3_000, limitMb: 2_048 }),
  },
  {
    id: "recovery",
    label: "Raise the limit",
    description: "The same working set gets headroom; cache stays full but reclaimable.",
    tone: "ok",
    params: defaults({ anonMb: 1_400, cacheMb: 2_000, limitMb: 3_072 }),
  },
];

const experiment: Experiment = {
  id: "predict-page-cache-oom",
  title: "Predict whether the OOM killer runs",
  simId: "linux-memory",
  question:
    "A host has 12,000 MB of page cache. A cgroup on that host reports 100% memory used, with 1,900 MB of anonymous memory against a 2,048 MB limit. Will the kernel OOM-kill the container?",
  prediction: {
    options: [
      { id: "yes-used", label: "Yes, 100% used means the cgroup is out of memory" },
      { id: "no-cache", label: "No, page cache is reclaimed first, but anonymous memory is close to the limit" },
      { id: "yes-cache", label: "Yes, page cache is anonymous memory and cannot be reclaimed" },
      { id: "no-host", label: "No, the host has free memory, so the cgroup cannot OOM" },
    ],
    correctOptionId: "no-cache",
    explanation:
      "memory.current includes file-backed page cache. Under pressure the kernel reclaims clean cache before it considers an OOM kill. The host cache is not the container footprint; the cgroup charges only the cache that fits. The real risk is the 1,900 MB anonymous working set against the 2,048 MB limit. If anonymous memory crossed the limit, the cgroup OOM killer would run even with free memory on the host.",
  },
  setup: defaults({ anonMb: 1_900, cacheMb: 12_000, limitMb: 2_048 }),
  runFor: 20,
  observe: [
    "Cgroup memory used stays at 100% while the OOM kill count remains zero.",
    "Anonymous memory is 93% of the limit; that is the number that matters.",
    "Memory pressure is elevated because the anonymous set is close to the limit.",
    "The host remains well below its own memory limit.",
  ],
  explain:
    "A high used percentage is not a diagnosis. The used total mixes anonymous memory, page cache, and kernel memory. Page cache is reclaimable and often fills the limit by design. Anonymous memory needs swap to leave RAM. A cgroup OOM happens when the unreclaimable part cannot fit under memory.max plus memory.swap.max, regardless of how much memory the host has.",
  fix: defaults({ anonMb: 1_200, cacheMb: 12_000, limitMb: 2_048 }),
  debrief:
    "Reducing the anonymous working set removes the OOM risk while the host keeps its page cache. Dropping caches would also lower the used percentage for a moment, but it would not change the anonymous footprint and would only hurt performance. Raise the limit only after you understand the working set; otherwise the next growth spurt returns.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Linux uses free memory for page cache. Reading a file leaves its pages in memory so the next read is faster. Those pages are file-backed and reclaimable: when memory is needed, the kernel can drop clean cache and write back dirty cache. Anonymous memory is different. Heap allocations, stacks, and anonymous mappings have no file behind them, so the kernel cannot simply drop them. It must swap them out or, if swap is unavailable, invoke the OOM killer.",
  },
  {
    type: "p",
    text: "RSS is resident set size: the pages of a process that are resident in RAM. It includes anonymous pages and file-backed pages, including pages shared with other processes, so RSS is not a synonym for anonymous memory. A process can have a large RSS made mostly of reclaimable file-backed pages. A cgroup adds a second boundary. In cgroup v2, memory.current includes the group's anonymous memory and its page cache, and memory.max is a hard limit. A container can be at 100% of its cgroup limit while the host has plenty of free memory. The used percentage alone therefore cannot tell you whether an OOM is near. You need the anonymous component, the effective limit, the swap allowance, and the pressure signal.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it does", "Pressure signal"],
    rows: [
      ["Process allocation", "Creates anonymous and file-backed pages", "Anonymous growth and RSS"],
      ["Cgroup memory controller", "Charges pages to the group and enforces memory.max", "memory.current and memory.pressure"],
      ["Host kernel", "Reclaims cache, swaps pages, and runs the OOM killer", "Reclaim, swap-in, and OOM events"],
      ["OOM killer", "Selects a process when the cgroup cannot reclaim enough", "oom_kill in memory.events"],
    ],
  },
  {
    type: "p",
    text: "The path is process allocation, the cgroup memory controller, the host kernel, and the OOM killer. The kernel first tries direct reclaim: it frees page cache and clean pages. If pressure persists, it may reclaim anonymous pages into swap. If it cannot reclaim enough, the cgroup OOM killer selects a process. The selection is influenced by oom_score and oom_score_adj, not just by the process that allocated the most memory.",
  },
  {
    type: "p",
    text: "This model uses one container on a 32 GB host with an 8 GB baseline for other workloads. The 1,024 MB swap allowance and the pressure curve are illustrative teaching values. The distinction between anonymous memory and reclaimable page cache is the lesson, not the exact megabyte at which a particular kernel kills a process.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cgroup memory used: the number that looks alarming and includes page cache.",
      "Anonymous vs effective limit: the number that predicts an OOM, including any swap allowance.",
      "Page cache: reclaimable memory that can fill the limit without causing a kill.",
      "RSS, memory pressure, and request p99: resident memory, reclaim or swap cost, and the latency before the kill.",
      "Swap used: whether anonymous pages are leaving RAM, and at what latency cost.",
    ],
  },
  {
    type: "table",
    headers: ["Signal", "What it means", "What it does not mean"],
    rows: [
      ["memory.current near memory.max", "The cgroup is using its allowance", "The memory is unreclaimable"],
      ["anon in memory.stat", "Heap and anonymous mappings", "The whole cgroup footprint"],
      ["file in memory.stat", "Page cache charged to the cgroup", "A leak or permanent usage"],
      ["memory.pressure", "Time lost to reclaim or allocation stalls", "The cgroup is out of memory now"],
      ["oom_kill in memory.events", "The kernel killed a process", "The host itself was out of memory"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Raise the page cache to 12,000 MB and watch used memory reach 100% without an OOM. Then raise the anonymous working set above the limit and watch pressure, p99, and OOM kills arrive together. Finally raise the limit and compare the same working set.",
  },
  { type: "sim", simId: "linux-memory" },
  { type: "experiment", experimentId: "predict-page-cache-oom" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The cgroup reported 100% memory used long before the OOM kill. The total was dominated by page cache, which the kernel can reclaim. The kill arrived when anonymous memory crossed the effective limit. At that point the page cache was irrelevant: reclaiming it could not create enough room for the anonymous working set.",
  },
  {
    type: "p",
    text: "Pressure rose before the kill and showed up in request p99. Raising the limit restored headroom and kept the cache full. Reducing the anonymous working set did the same thing without spending more memory. Dropping caches would have moved the used percentage and changed nothing about the OOM risk.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "cgroup v2: memory.current, memory.max, memory.stat (anon, file), memory.pressure, and memory.events (oom, oom_kill).",
      "Host: `free -m` available versus free, /proc/meminfo, and the OOM reports in dmesg.",
      "Kubernetes: container_memory_working_set_bytes, container_memory_rss, and the pod's OOMKilled status or restart count.",
      "Swap: vmstat si/so, pswpin/pswpout, and major page faults per process.",
      "Traces: latency stalls that correlate with reclaim or swap-in rather than CPU or downstream calls.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the anonymous component against memory.max, not the used percentage. Check memory.pressure and memory.events, then confirm whether the host or the cgroup was the limit. A host with free memory does not protect a cgroup from its own hard limit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the kill: check memory.events oom_kill and the kernel OOM report for the cgroup and PID.",
      "Separate anonymous memory from page cache in memory.stat.",
      "Find what grew the anonymous set: heap, thread stacks, buffers, or a leak.",
      "Reduce the working set or raise memory.max with enough headroom for peak, not just the current value.",
      "Use swap only if the latency cost is acceptable and the swap device has capacity.",
      "Re-run the peak workload and verify pressure, p99, and OOM events together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Raising the limit is fast and can hide a leak until the next growth spurt.",
      "Reducing the working set is durable but may require a code or configuration change.",
      "Swap avoids an OOM and can turn a hard failure into a slow one; for latency-sensitive services that is often worse.",
      "Dropping page cache lowers the used graph and hurts performance without changing the anonymous footprint.",
      "A host-level memory dashboard is not a substitute for per-cgroup limits. The two boundaries fail independently.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-meminfo",
    question:
      "A host reports 90% memory used but no swapping. How do you decide whether it is about to OOM?",
    difficulty: 2,
    hints: [
      "Used memory includes page cache.",
      "Check available memory and the anonymous component.",
    ],
    answer:
      "I would not use the used percentage alone. I would check MemAvailable, the anonymous and file-backed components, swap usage, and the cgroup limits. If most of the used memory is page cache and MemAvailable is healthy, the host can reclaim it and is not close to OOM. If anonymous memory is growing toward a cgroup limit, the host-level free memory is irrelevant. I would also check memory.pressure and OOM events, because pressure rises before the kill.",
    followUps: [
      "What is the difference between free and available?",
      "How would a cgroup change the answer?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Treats used memory as anonymous memory.",
      "Ignores cgroup limits.",
      "Recommends dropping caches as a fix.",
    ],
    rubric: [
      "Separates cache from anonymous memory.",
      "Reads available memory.",
      "Checks the cgroup boundary.",
      "Names pressure before OOM.",
    ],
  },
  {
    id: "oom-cause",
    question:
      "A pod restarts with OOMKilled every few hours. The node has 40% memory free. What do you check?",
    difficulty: 3,
    hints: [
      "The node is not the only limit.",
      "Look at the container's anonymous growth over time.",
    ],
    answer:
      "The pod is hitting its container limit, not the node limit. I would check container_memory_working_set_bytes and RSS against the pod's memory limit, then inspect the anonymous growth pattern: heap, cache, thread stacks, or a leak. I would also check whether the working set spikes during a specific request or batch, and whether the limit was recently lowered. The fix is either to reduce the growth or raise the limit with headroom; restarting without changing either just resets the timer.",
    followUps: [
      "How would you distinguish a leak from a legitimate peak?",
      "What does working set include that RSS does not?",
      "When would you add swap?",
    ],
    redFlags: [
      "Blames the node because it has free memory.",
      "Raises the limit without finding the growth.",
      "Restarts the pod and closes the incident.",
    ],
    rubric: [
      "Identifies the container limit.",
      "Separates leak from peak.",
      "Names the metric to inspect.",
      "Proposes a durable fix.",
    ],
  },
  {
    id: "page-cache",
    question:
      "A container shows 100% memory used and 8 GB of page cache. Should you drop caches before the next deploy?",
    difficulty: 2,
    hints: [
      "Page cache is reclaimable.",
      "Dropping it costs performance and does not change anonymous memory.",
    ],
    answer:
      "No. Page cache is reclaimable, and the kernel will drop it under pressure. Dropping it manually lowers the used graph and warms up the workload again, which hurts performance. The relevant question is how much anonymous memory the container uses against its limit. If anonymous memory is close to the limit, reduce it or raise the limit. If it is not, the cache is doing its job.",
    followUps: [
      "When can page cache contribute to an OOM?",
      "What is dirty page cache, and why does it matter?",
      "How would you prove the cache is reclaimable?",
    ],
    redFlags: [
      "Treats all used memory as anonymous.",
      "Drops caches as routine hygiene.",
      "Ignores dirty writeback.",
    ],
    rubric: [
      "Defines page cache as reclaimable.",
      "Focuses on anonymous memory.",
      "Notes the performance cost.",
      "Mentions dirty pages.",
    ],
  },
  {
    id: "limit-vs-request",
    question:
      "How do you choose a container memory limit and request for a service with a 2 GB steady working set and a 3.5 GB peak?",
    difficulty: 3,
    hints: [
      "The limit must cover the peak, not the average.",
      "The request affects scheduling; the limit affects the kill.",
    ],
    answer:
      "I would set the limit above the observed peak with room for allocator and kernel overhead, and set the request close to the steady working set so the scheduler reserves realistic capacity. A limit at the average would kill the pod at every peak. A request equal to the peak would waste cluster capacity at steady state. I would verify with a load test and watch memory.pressure and OOM events, not just the used graph.",
    followUps: [
      "What happens if the request is much lower than the limit?",
      "How does node pressure change eviction behavior?",
      "Would you use a VPA or a fixed limit?",
    ],
    redFlags: [
      "Sets the limit at the average.",
      "Sets the request at the peak without evidence.",
      "Ignores eviction and node pressure.",
    ],
    rubric: [
      "Separates request and limit.",
      "Covers peak in the limit.",
      "Uses measurement.",
      "Considers node eviction.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every container has a memory request and limit reviewed against a peak load test.",
      "Dashboards show anonymous memory, page cache, and memory.pressure per cgroup.",
      "OOM events and restart counts are alerted, not just used percentage.",
      "Swap policy is explicit and tested for latency-sensitive services.",
      "The host and cgroup limits are both visible in the same view.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the limit is the cgroup or the node.",
      "Separate anonymous growth from page cache.",
      "Check memory.pressure and OOM events before restarting.",
      "Look for a recent limit change or a new workload with a larger working set.",
      "Watch p99 and swap-in after any mitigation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Find the allocation that grew and fix or bound it.",
      "Revisit the limit with peak headroom, not the incident value.",
      "Add a pressure alert if the used graph fired too late.",
      "Test the workload at peak with the new limit.",
    ],
  },
];

const references = [
  {
    title: "Control Group v2",
    url: "https://docs.kernel.org/admin-guide/cgroup-v2.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "memory.current, memory.max, memory.stat, memory.pressure, and OOM behavior.",
  },
  {
    title: "free(1)",
    url: "https://man7.org/linux/man-pages/man1/free.1.html",
    publisher: "Linux man-pages",
    kind: "docs" as const,
    note: "Used, free, available, buffers, and cache columns.",
  },
  {
    title: "The /proc filesystem",
    url: "https://docs.kernel.org/filesystems/proc.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "meminfo, pressure, and per-process memory fields.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "linux-memory": {
      model: linuxMemoryModel,
      presets,
      instructions:
        "Start healthy, then raise page cache and anonymous memory separately. Watch used memory reach 100% without an OOM, then push anonymous memory past the cgroup limit.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One container on a 32 GB host; pressure and swap values are teaching values, not a kernel guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-linux-cpu", "foundations-linux-disk-io", "foundations-file-descriptors"],
};
