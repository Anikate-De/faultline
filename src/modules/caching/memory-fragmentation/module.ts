import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CONTAINER_LIMIT_GB = 12;

const params = [
  {
    id: "datasetGb",
    label: "Logical dataset",
    min: 2,
    max: 32,
    step: 1,
    value: 6,
    unit: " GB",
    group: "Memory",
    help: "The logical dataset Redis holds. used_memory also includes buffers and overhead, so it is larger than this value.",
    format: "number" as const,
  },
  {
    id: "churnPct",
    label: "Key churn",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Workload",
    help: "Share of the dataset replaced per minute. Churn creates free chunks the allocator may not return to the OS.",
    format: "percent" as const,
  },
  {
    id: "replicaBuffersGb",
    label: "Replica buffers",
    min: 0,
    max: 8,
    step: 0.5,
    value: 0.5,
    unit: " GB",
    group: "Topology",
    help: "Replication backlog and output buffers. Redis documents that these are outside the maxmemory comparison.",
    format: "number" as const,
  },
  {
    id: "defrag",
    label: "Active defrag",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Mitigation",
    help: "0 default allocator behavior, 1 active defragmentation and aggressive purge. It reduces fragmentation, not replica buffers.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  datasetGb: number;
  usedMemoryGb: number;
  churnPct: number;
  replicaBuffersGb: number;
  defrag: boolean;
  fragRatio: number;
  rssGb: number;
  overLimitGb: number;
}

function compute(p: Params): Values {
  const datasetGb = Math.max(0.5, num(p, "datasetGb", 6));
  const churnPct = clamp(num(p, "churnPct", 20), 0, 100);
  const replicaBuffersGb = Math.max(0, num(p, "replicaBuffersGb", 0.5));
  const defrag = num(p, "defrag", 0) >= 0.5;
  const fragRatio = clamp(
    1.05 + (churnPct / 100) * 0.5 + Math.max(0, replicaBuffersGb - 2) * 0.03 - (defrag ? 0.3 : 0),
    1.02,
    3,
  );
  const usedMemoryGb = datasetGb + replicaBuffersGb;
  const rssGb = usedMemoryGb * fragRatio;
  return {
    datasetGb,
    usedMemoryGb,
    churnPct,
    replicaBuffersGb,
    defrag,
    fragRatio,
    rssGb,
    overLimitGb: Math.max(0, rssGb - CONTAINER_LIMIT_GB),
  };
}

function rssHealth(rss: number): "ok" | "warn" | "crit" {
  if (rss >= CONTAINER_LIMIT_GB) return "crit";
  if (rss >= 10) return "warn";
  return "ok";
}

function fragHealth(ratio: number): "ok" | "warn" | "crit" {
  if (ratio >= 1.7) return "crit";
  if (ratio >= 1.5) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 5)) / 2.6);
  frame.series["rss"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.rssGb * wave(index)));
  frame.series["frag-ratio"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.fragRatio * wave(index + 2)),
  );
  frame.series["replica-buffers"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.replicaBuffersGb * wave(index + 3)),
  );
  frame.series["used-memory"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.usedMemoryGb * wave(index + 4)),
  );
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const allocatorHealth = fragHealth(v.fragRatio);
  const processHealth = rssHealth(v.rssGb);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "dataset",
        label: "used_memory",
        kind: "cache",
        health: "ok",
        sublabel: `${v.usedMemoryGb.toFixed(1)} GB allocated`,
        detail: "Total Redis allocations, including the dataset and replica buffers. maxmemory compares a subset that excludes some buffers; the container limit applies to RSS.",
        meta: { view: "flow" },
      },
      {
        id: "allocator",
        label: "Allocator arenas",
        kind: "worker",
        health: allocatorHealth,
        utilization: clamp(v.fragRatio / 3),
        sublabel: `ratio ${v.fragRatio.toFixed(2)}`,
        detail: "jemalloc retains freed pages when they are interleaved with live allocations. A high churn workload can leave RSS above the logical dataset.",
        meta: { view: "flow" },
      },
      {
        id: "rss",
        label: "Process RSS",
        kind: "storage",
        health: processHealth,
        utilization: clamp(v.rssGb / CONTAINER_LIMIT_GB),
        sublabel: `${v.rssGb.toFixed(1)} GB resident`,
        detail: "Resident set size includes the logical dataset, fragmentation, allocator metadata, and replication buffers. The container limit applies here.",
        meta: { view: "flow" },
      },
      {
        id: "container",
        label: "Container limit",
        kind: "external",
        health: processHealth,
        utilization: clamp(v.rssGb / CONTAINER_LIMIT_GB),
        sublabel: `${CONTAINER_LIMIT_GB} GB · ${v.overLimitGb > 0 ? `${v.overLimitGb.toFixed(1)} GB over` : "headroom"}`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("dataset-allocator", "dataset", "allocator", clamp(v.fragRatio / 3), allocatorHealth),
      edge("allocator-rss", "allocator", "rss", clamp(v.rssGb / CONTAINER_LIMIT_GB), processHealth),
      edge("rss-container", "rss", "container", clamp(v.rssGb / CONTAINER_LIMIT_GB), processHealth),
    ],
    metrics: [
      metric("rss", "Process RSS", v.rssGb, " GB", 10, CONTAINER_LIMIT_GB, "number"),
      metric("frag-ratio", "Fragmentation ratio", v.fragRatio, "", 1.5, 2, "number"),
      metric("replica-buffers", "Replica buffers", v.replicaBuffersGb, " GB", 2, 4, "number"),
      metric("used-memory", "used_memory", v.usedMemoryGb, " GB", undefined, undefined, "number"),
      metric("over-limit", "Over container limit", v.overLimitGb, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `used_memory ${v.usedMemoryGb.toFixed(1)} GB, RSS ${v.rssGb.toFixed(1)} GB, fragmentation ${v.fragRatio.toFixed(2)}, replica buffers ${v.replicaBuffersGb.toFixed(1)} GB.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rss",
    metricId: "rss",
    warn: 10,
    crit: CONTAINER_LIMIT_GB,
    title: "RSS reaches the container limit while used_memory is lower",
    cause:
      "The process holds resident pages beyond the logical dataset: allocator fragmentation, peak-usage pages that were not returned, allocator metadata, and replication buffers. The container kills on RSS, not on used_memory.",
    fix:
      "Provision for peak RSS, not only the current dataset. Reduce churn, cap replica buffers, enable active defrag if the allocator can release pages, or give the process more headroom. Lowering maxmemory alone may not shrink RSS.",
    checkFirst: [
      "Read `INFO memory` and compare `used_memory` with `used_memory_rss`.",
      "Check `mem_fragmentation_ratio` and whether the instance recently had a higher peak.",
      "Check `mem_not_counted_for_evict` and replica buffer sizes.",
    ],
  },
  {
    id: "frag-ratio",
    metricId: "frag-ratio",
    warn: 1.5,
    crit: 1.7,
    title: "Allocator fragmentation is high",
    cause:
      "Freed allocations are interleaved with live ones, so the allocator keeps pages it cannot return. Churn, mixed value sizes, and a higher earlier peak make the ratio large.",
    fix:
      "Reduce churn and value-size variance, enable active defrag where supported, or restart during a controlled window. The ratio is not reliable when the current dataset is far below an earlier peak.",
    checkFirst: [
      "Compare current `used_memory` with the process's peak.",
      "Check `allocator_frag_ratio` and `allocator_frag_bytes` in `INFO memory`.",
      "Check whether a large delete or expiry wave preceded the rise.",
    ],
  },
  {
    id: "replica-buffers",
    metricId: "replica-buffers",
    title: "Replication buffers are consuming headroom",
    cause:
      "The replication backlog and per-replica output buffers are process memory but are not counted in the maxmemory comparison. Slow or disconnected replicas can grow them.",
    fix:
      "Cap the backlog and replica output buffer limits, fix slow replicas, and leave headroom for buffers outside maxmemory. A replica that cannot keep up is also a freshness risk.",
    warn: 2,
    crit: 4,
    checkFirst: [
      "Check replica lag and the output buffer size per replica.",
      "Check the configured backlog size and client-output-buffer-limit.",
      "Check whether a replica is disconnected or slow to apply the stream.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const memoryFragmentationModel: SimModel = {
  id: "caching-memory-fragmentation",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const jittered: Params = {
      ...p,
      datasetGb: num(p, "datasetGb", 6) * (1 + rng.between(-0.002, 0.002) * Math.min(1, dt / 0.1)),
    };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (!reset) {
      next.series = Object.fromEntries(Object.entries(frame.series).map(([k, values]) => [k, [...values]]));
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events];
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `used_memory is ${v.usedMemoryGb.toFixed(1)} GB, of which ${v.datasetGb.toFixed(1)} GB is dataset and ${v.replicaBuffersGb.toFixed(1)} GB is replica buffers. RSS is ${v.rssGb.toFixed(1)} GB.`,
      `Fragmentation ratio is ${v.fragRatio.toFixed(2)}. Redis documents RSS as the physical pages and used_memory as current allocations; the ratio is not reliable when the process had a much higher peak.`,
      `Replication buffers are part of used_memory but outside the maxmemory comparison. A slow replica can grow them without triggering eviction.`,
      v.defrag
        ? "Active defrag is on: the model reduces fragmentation, but it cannot remove replica buffers or make the container limit larger."
        : "Active defrag is off. Churn leaves free chunks that the allocator may keep; peak memory, not average usage, sets the safe container size.",
    ];
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
    description: "A 6 GB dataset with modest churn and small replica buffers fits the 12 GB limit.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 7 GB dataset with 50% churn and 1.5 GB of replica buffers approaches the limit.",
    tone: "warn",
    params: defaults({ datasetGb: 7, churnPct: 50, replicaBuffersGb: 1.5 }),
  },
  {
    id: "failure",
    label: "Fragmented and buffered",
    description: "A 9 GB dataset with 90% churn and 3 GB of replica buffers pushes RSS past the limit.",
    tone: "crit",
    params: defaults({ datasetGb: 9, churnPct: 90, replicaBuffersGb: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Active defrag, lower churn, and smaller buffers bring RSS under the warning line.",
    tone: "ok",
    params: defaults({ datasetGb: 8, churnPct: 70, replicaBuffersGb: 1, defrag: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-rss-gap",
  title: "Predict where the memory went",
  simId: "memory-fragmentation",
  question:
    "The logical dataset is 9 GB, used_memory is 12 GB, and the process RSS is nearly 18 GB in a 12 GB container. What explains the difference?",
  prediction: {
    options: [
      { id: "frag", label: "Replica buffers raise used_memory above the dataset, and allocator fragmentation from churn raises RSS above used_memory." },
      { id: "leak", label: "A key leak: Redis is still holding every key it ever stored." },
      { id: "lag", label: "Replication lag alone, because lag is measured in the same bytes as memory." },
      { id: "swap", label: "Swap usage, which Redis counts as part of used_memory." },
    ],
    correctOptionId: "frag",
    explanation:
      "used_memory counts current Redis allocations, including replica buffers. RSS counts resident pages, including allocator metadata and fragmentation. The allocator can keep pages after data is freed, especially when live and freed allocations share pages, and a higher earlier peak leaves RSS high. Replica buffers explain part of the gap between the dataset and used_memory; fragmentation explains the gap between used_memory and RSS. Neither is a key leak.",
  },
  setup: defaults({ datasetGb: 9, churnPct: 90, replicaBuffersGb: 3 }),
  runFor: 12,
  observe: [
    "Fragmentation ratio is above 1.5 while used_memory is stable.",
    "Replica buffers add several GB that maxmemory does not count.",
    "RSS crosses the container limit and the process becomes the failing node.",
    "Defrag lowers the ratio but cannot remove the replica buffers.",
  ],
  explain:
    "The container limit applies to RSS. The dataset never leaked; replica buffers raised used_memory, and fragmentation from churn raised RSS above it. Active defrag reduced the fragmented share in the recovery preset, while capping buffers and leaving headroom handled the rest. Restarting would also reset RSS, at the cost of a cold cache and a rebuild.",
  fix: defaults({ datasetGb: 8, churnPct: 70, replicaBuffersGb: 1, defrag: 1 }),
  debrief:
    "The recovery preset fit because it changed all three contributors: higher churn is still present but defrag is on, the replica buffers are smaller, and the dataset is lower. If only the dataset had been reduced, RSS might have stayed close to the old peak. The safe container size is the peak RSS, not the current used_memory.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis reports two memory numbers that are easy to confuse. `used_memory` is the total bytes Redis has allocated, including the dataset, key and value overhead, client buffers, and replication buffers. `used_memory_rss` is the resident set size, the physical pages the process holds. RSS includes fragmentation, allocator metadata, and everything in used_memory. The fragmentation ratio is RSS divided by used_memory. A ratio near 1 means the allocator is returning memory efficiently; a high ratio means the process holds pages beyond the current dataset.",
  },
  {
    type: "p",
    text: "The gap is not necessarily a leak. jemalloc allocates in size classes and arenas. When keys are deleted or expired, freed chunks may be interleaved with live allocations on the same pages, so the allocator cannot return those pages to the operating system. If the process previously held a larger dataset, RSS can stay near that peak long after used_memory falls. Redis documents this and recommends provisioning for peak memory, not average usage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The layers are the logical dataset, the allocator, the process RSS, and the container limit. maxmemory and eviction act on the dataset. The container limit acts on RSS. Replication adds another layer: the backlog and per-replica output buffers are process memory but are not included in the maxmemory comparison, so a slow replica can raise RSS without triggering eviction.",
  },
  {
    type: "table",
    headers: ["Component", "In used_memory", "In RSS", "In maxmemory comparison", "What makes it grow"],
    rows: [
      ["Dataset and key overhead", "Yes", "Yes", "Yes", "More keys, larger values, more members"],
      ["Allocator fragmentation", "No", "Yes", "No", "Churn, mixed sizes, a higher earlier peak"],
      ["Allocator metadata", "No", "Yes", "No", "Many arenas, size classes, thread caches"],
      ["Replication backlog and output buffers", "Yes", "Yes", "No", "Write rate, slow or disconnected replicas"],
      ["Client buffers and connections", "Yes", "Yes", "Yes", "Large commands, many clients, slow consumers"],
    ],
  },
  {
    type: "p",
    text: "This module uses a 12 GB container limit, 2–32 GB datasets, and illustrative fragmentation factors. The limit and factors are teaching values, not Redis defaults. The relationship is the lesson: the container limit applies to RSS, and RSS can exceed used_memory.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "used_memory and process RSS, with the gap stated in GB.",
      "Fragmentation ratio, with a warning at 1.5 and critical at 1.7 in this model.",
      "Replica buffers, which are outside maxmemory but inside the container.",
      "A container node that fails when RSS crosses its limit, even if the dataset is stable.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Fragmented and buffered. Watch used_memory stay at 12 GB while RSS crosses the 12 GB limit. Turn active defrag on to see the ratio fall, then reduce the replica buffers. Run the experiment before the debrief.",
  },
  {
    type: "compare",
    leftTitle: "Scale for used_memory",
    rightTitle: "Scale for peak RSS",
    rows: [
      { label: "What you measure", left: "Current logical dataset", right: "Resident pages at the highest sustained workload" },
      { label: "Risk", left: "The container OOMs while the dataset looks fine", right: "You pay for headroom that is idle most of the time" },
      { label: "Mitigation", left: "None; it does not address fragmentation or buffers", right: "Defrag, buffer caps, and peak-based sizing" },
    ],
  },
  {
    type: "p",
    text: "The first question is not why used_memory is 6 GB. It is why RSS is 10 GB. Read both numbers, the fragmentation ratio, the allocator breakdown, and the replication buffers before concluding that keys are leaking. Then size for the peak the process has actually held.",
  },
  { type: "sim", simId: "memory-fragmentation" },
  { type: "experiment", experimentId: "predict-rss-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "used_memory was stable at 12 GB, but the process held more than 18 GB of resident pages. Churn left freed chunks interleaved with live data, so the allocator kept pages it could not return. Replica buffers added several GB to used_memory, outside the maxmemory comparison. The container limit applied to the total, so the process failed while used_memory looked unchanged.",
  },
  {
    type: "p",
    text: "Active defrag reduced the fragmented share, and smaller buffers removed the rest of the excess. The dataset did not leak. The recovery worked because it addressed the three contributors separately instead of only lowering maxmemory.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`INFO memory`: `used_memory`, `used_memory_rss`, `mem_fragmentation_ratio`, `allocator_frag_ratio`, and `mem_not_counted_for_evict`.",
      "Container metrics: working set and RSS against the limit, plus OOM kill events.",
      "Redis replication: per-replica output buffer size and lag.",
      "Key churn: expired and evicted keys per second, and large delete or backfill events.",
      "Host logs: the kernel OOM killer, not a Redis command error, when RSS reaches the cgroup limit.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare used_memory with RSS and read the fragmentation ratio. Then check replica buffers and the process's recent peak. If RSS is high but used_memory is stable, the dataset is not the whole story.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the gap: used_memory versus RSS, fragmentation ratio, and allocator breakdown.",
      "Check whether the process recently held a larger peak; RSS may be slow to fall.",
      "Cap replica buffers and fix slow or disconnected replicas.",
      "Reduce churn and value-size variance, or enable active defrag where supported.",
      "Size the container for peak RSS with headroom, not the current logical dataset.",
      "If a restart is the only way to reset RSS, plan the cold-cache rebuild before doing it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Active defrag reduces fragmentation at a CPU cost and does not remove replica buffers.",
      "Restarting resets RSS and causes a cold cache, shifting load to the origin.",
      "Capping replica buffers protects memory but can disconnect a slow replica, reducing read capacity.",
      "Sizing for peak RSS is safe and can leave expensive headroom idle most of the time.",
      "Lowering maxmemory limits the dataset but may not shrink RSS if the pages are already fragmented.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-memory-gap",
    question:
      "used_memory is 6 GB, the process uses 10 GB, and the container limit is 12 GB. How do you investigate?",
    difficulty: 3,
    hints: [
      "Start with used_memory versus RSS, not with the key count.",
      "Fragmentation and replication buffers live outside the dataset.",
    ],
    answer:
      "I would read `INFO memory` and compare `used_memory` with `used_memory_rss`, then look at `mem_fragmentation_ratio` and the allocator breakdown. A high ratio points to fragmentation; `mem_not_counted_for_evict` and replica buffer sizes explain memory outside maxmemory. I would check whether the process recently held a larger peak, because RSS can stay near that peak after the dataset shrinks. I would also check client buffers and whether a replica is slow. Only after those would I consider a leak. The container limit applies to RSS, so that is the number to size against.",
    followUps: [
      "How would you tell fragmentation from a leak?",
      "When would you restart, and what does that cost?",
      "What would you change before raising the container limit?",
    ],
    redFlags: [
      "Assumes RSS equals the dataset.",
      "Restarts before checking buffers and fragmentation.",
      "Ignores the peak-memory history.",
    ],
    rubric: [
      "Compares used_memory and RSS.",
      "Names fragmentation and buffers.",
      "Checks peak history.",
      "Sizes against RSS.",
    ],
  },
  {
    id: "choose-mitigation",
    question:
      "RSS is close to the limit. Do you enable active defrag, cap replica buffers, or add memory?",
    difficulty: 3,
    hints: [
      "Separate the contributors before choosing a control.",
      "Each option affects a different part of RSS.",
    ],
    answer:
      "I would separate the gap into fragmentation, buffers, and dataset. If fragmentation dominates, active defrag may help, but it costs CPU and cannot fix buffers. If replica buffers dominate, I would cap them and fix the slow replica first, because adding memory leaves the growth path in place. If the dataset itself is at the limit, I would reduce it or add memory with headroom. In an incident I would do the fastest safe step first, then verify RSS and the OOM risk. Raising the limit is a last resort if the other contributors are understood.",
    followUps: [
      "What would make you choose a restart?",
      "How do you verify defrag worked?",
      "What is the risk of capping replica buffers too aggressively?",
    ],
    redFlags: [
      "Adds memory without identifying the contributor.",
      "Enables defrag and expects buffers to shrink.",
      "Restarts during peak without a cold-cache plan.",
    ],
    rubric: [
      "Separates fragmentation, buffers, and dataset.",
      "Matches control to contributor.",
      "Names the cost of each option.",
      "Verifies the result.",
    ],
  },
  {
    id: "size-container",
    question:
      "How do you decide the container memory limit for a Redis cache whose dataset grows?",
    difficulty: 3,
    hints: [
      "Use peak RSS, not average used_memory.",
      "Leave room for fragmentation, buffers, and failover.",
    ],
    answer:
      "I would start from the peak dataset the instance must hold, add expected fragmentation and allocator overhead, add the replication backlog and output buffers, and leave headroom for client buffers and failover. Then I would load-test at peak and watch RSS, not only used_memory. I would set the limit above the observed peak with a margin, and alert on RSS approaching it. If the dataset grows, the limit and the eviction policy need to be revisited together. A limit set from the current dataset will eventually OOM during a backfill or a replica catch-up.",
    followUps: [
      "How would a replica change the memory estimate?",
      "What alarm would you set below the limit?",
      "How often would you revalidate the number?",
    ],
    redFlags: [
      "Sizes from current used_memory.",
      "Forgets replica buffers.",
      "Sets the limit equal to the dataset.",
    ],
    rubric: [
      "Uses peak RSS.",
      "Includes buffers and fragmentation.",
      "Leaves headroom.",
      "Plans revalidation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show used_memory, RSS, fragmentation ratio, and replica buffers together.",
      "The container limit is based on measured peak RSS, not the current dataset.",
      "Replica output buffer limits and the backlog size are reviewed.",
      "A churn or backfill test has been run against the memory limit.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare used_memory with RSS and the fragmentation ratio.",
      "Check replica buffers and slow replicas before blaming the dataset.",
      "Check whether the process recently held a larger peak.",
      "Protect the origin before a restart empties the cache.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reduce churn or enable defrag if fragmentation is the cause.",
      "Cap buffers and fix the slow replica if replication is the cause.",
      "Re-size the container with peak headroom.",
      "Record the remaining gap and the next growth trigger.",
    ],
  },
];

const references = [
  {
    title: "Memory optimization",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "RSS versus used_memory, allocator behavior, and peak provisioning.",
  },
  {
    title: "INFO command",
    url: "https://redis.io/docs/latest/commands/info/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Memory and replication fields used in the checklist.",
  },
  {
    title: "jemalloc",
    url: "https://jemalloc.net/",
    publisher: "jemalloc project",
    kind: "docs" as const,
    note: "Allocator size classes, arenas, and retained pages.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "memory-fragmentation": {
      model: memoryFragmentationModel,
      presets,
      instructions:
        "Start healthy, then apply Fragmented and buffered. Watch used_memory stay flat while RSS crosses the container limit. Enable active defrag, then reduce replica buffers in Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 12 GB container limit and fragmentation factors are teaching values, not Redis defaults. used_memory and RSS are modeled as separate layers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["caching-eviction-policies", "caching-read-replicas", "caching-big-keys"],
};
