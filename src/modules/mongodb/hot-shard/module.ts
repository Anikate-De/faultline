import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 4;
const TOTAL_CHUNKS = 240;
const SHARD_CAPACITY_OPS = 12_000;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "writeRate",
    label: "Write rate",
    min: 4_000,
    max: 40_000,
    step: 1_000,
    value: 14_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Operations hitting the sharded collection. Illustrative capacity is 12,000 ops/s per shard.",
    format: "rps",
  },
  {
    id: "hotKeyShare",
    label: "Traffic on the hottest key",
    min: 0,
    max: 60,
    step: 1,
    value: 0,
    unit: "%",
    group: "Key distribution",
    help: "Share of operations aimed at one key value. That value lives in one chunk and cannot be split across shards.",
    format: "percent",
  },
  {
    id: "keyPattern",
    label: "Key growth pattern",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Key distribution",
    help: "0 = random key values, 1 = monotonically increasing values such as a timestamp. A monotonic key appends writes to the top chunk.",
    format: "count",
  },
  {
    id: "balancerRate",
    label: "Balancer migration rate",
    min: 0,
    max: 8,
    step: 1,
    value: 4,
    unit: " chunks/min",
    group: "Balancer",
    help: "How quickly the balancer moves chunks toward an even chunk count. Chunk balance is not the same as write balance.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  writeRate: number;
  hotKeyShare: number;
  keyPattern: number;
  balancerRate: number;
  hottestShare: number;
  imbalance: number;
  hotCpu: number;
  avgCpu: number;
  queryP99: number;
  chunkSkew: number;
  chunksOnHot: number;
  chunkTarget: number;
  writes: number[];
  cpus: number[];
}

function compute(p: Params, t: number): Computed {
  const writeRate = clamp(num(p, "writeRate", 14_000), 0, 40_000);
  const hotKeyShare = clamp(num(p, "hotKeyShare", 0), 0, 60) / 100;
  const keyPattern = Math.round(clamp(num(p, "keyPattern", 0), 0, 1));
  const balancerRate = clamp(num(p, "balancerRate", 4), 0, 8);
  const hottestShare = clamp(0.25 + hotKeyShare * 0.7 + (keyPattern === 1 ? 0.35 : 0), 0.25, 0.98);
  const imbalance = hottestShare * SHARD_COUNT;
  const hotCpu = (writeRate * hottestShare * 100) / SHARD_CAPACITY_OPS;
  const avgCpu = (writeRate * 100) / (SHARD_COUNT * SHARD_CAPACITY_OPS);
  const util = Math.min(0.97, hotCpu / 100);
  const queryP99 = Math.min(MAX_P99_MS, 4 + (45 * util) / (1 - util));
  const skewStart = Math.max(1, 1.4 - balancerRate * 0.05);
  const chunkSkew = 1 + (skewStart - 1) * Math.exp(-(balancerRate * t) / 45);
  const chunkTarget = TOTAL_CHUNKS / SHARD_COUNT;
  const chunksOnHot = chunkTarget * chunkSkew;
  const hotWrites = writeRate * hottestShare;
  const otherWrites = (writeRate - hotWrites) / (SHARD_COUNT - 1);
  const writes = Array.from({ length: SHARD_COUNT }, (_, index) => (index === 0 ? hotWrites : otherWrites));
  const cpus = writes.map((value) => (value * 100) / SHARD_CAPACITY_OPS);
  return {
    writeRate,
    hotKeyShare,
    keyPattern,
    balancerRate,
    hottestShare,
    imbalance,
    hotCpu,
    avgCpu,
    queryP99,
    chunkSkew,
    chunksOnHot,
    chunkTarget,
    writes,
    cpus,
  };
}

function healthFor(cpu: number, p99: number): Health {
  if (cpu >= 90 || p99 >= 150) return "crit";
  if (cpu >= 70 || p99 >= 50) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Computed, t: number): SimFrame {
  const nodes: SimNode[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const cpu = values.cpus[index] ?? 0;
    const isHot = cpu >= 70;
    const shardChunks =
      index === 0
        ? values.chunksOnHot
        : values.chunkTarget - (values.chunksOnHot - values.chunkTarget) / (SHARD_COUNT - 1);
    const p99 = isHot ? values.queryP99 : Math.min(values.queryP99, 4 + cpu * 0.7);
    return {
      id: `shard-${index}`,
      label: `Shard ${index}`,
      kind: "db" as const,
      role: "shard" as const,
      health: healthFor(cpu, p99),
      utilization: clamp(cpu / 100),
      throughput: values.writes[index] ?? 0,
      sublabel: isHot
        ? `${shardChunks.toFixed(0)} chunks · hot`
        : `${shardChunks.toFixed(0)} chunks`,
      detail: `${(values.writes[index] ?? 0).toFixed(0)} ops/s and ${cpu.toFixed(0)}% CPU. The write-hot shard holds ${values.chunksOnHot.toFixed(0)} chunks versus a ${values.chunkTarget.toFixed(0)}-chunk average; chunk count is not write load.`,
      meta: {
        view: "shards",
        cpu,
        memory: 8 + values.writeRate / 6_000,
        p99,
        chunks: Math.round(shardChunks),
        hot: isHot ? 1 : 0,
      },
    };
  });

  return {
    t,
    nodes,
    edges: [],
    metrics: [
      metric("hot-shard-cpu", "Hot shard CPU", values.hotCpu, "%", 70, 90, "percent"),
      metric("query-p99", "Hot shard p99", values.queryP99, "ms", 50, 150, "ms"),
      metric("write-imbalance", "Write imbalance", values.imbalance, "x", 2.5, 3.5, "number"),
      metric("chunk-skew", "Chunk-count skew", values.chunkSkew, "x", 1.32, 1.38, "number"),
      metric("chunks-on-hot-shard", "Chunks on write-hot shard", values.chunksOnHot, "", undefined, undefined, "count"),
      metric("avg-shard-cpu", "Average shard CPU", values.avgCpu, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, keyPattern: values.keyPattern, balancerRate: values.balancerRate },
    summary: `Write-hot shard ${values.hotCpu.toFixed(0)}% CPU with ${values.chunksOnHot.toFixed(0)} chunks; average shard ${values.avgCpu.toFixed(0)}%; chunk skew ${values.chunkSkew.toFixed(2)}x.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, t: number, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 4)) / 2.2);
  const rows: [string, number][] = [
    ["hot-shard-cpu", values.hotCpu],
    ["query-p99", values.queryP99],
    ["write-imbalance", values.imbalance],
    ["chunk-skew", values.chunkSkew],
    ["chunks-on-hot-shard", values.chunksOnHot],
    ["avg-shard-cpu", values.avgCpu],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.nodes.forEach((node, index) => {
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, point) =>
      Math.max(0, (values.cpus[index] ?? 0) * jitter(point + t)),
    );
  });
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-cpu",
    metricId: "hot-shard-cpu",
    warn: 70,
    crit: 90,
    title: "One shard carries the write load",
    cause:
      "A hot key value or a monotonically increasing key sends a large share of operations to one chunk. That chunk lives on one shard, so the shard saturates while its peers have capacity.",
    fix:
      "Change the distribution: split the hot value in the application, add a bucket or tenant prefix to the key, or use a ranged key that does not append to one end. Moving the chunk transfers the same traffic to another shard; it does not reduce it.",
    checkFirst: [
      "Check writes per shard, not chunks per shard.",
      "Check the hottest key values and whether the key is monotonic.",
      "Check whether the balancer is running before blaming it.",
    ],
  },
  {
    id: "query-p99",
    metricId: "query-p99",
    warn: 50,
    crit: 150,
    title: "The hot shard sets the query tail",
    cause:
      "Once the hot shard approaches its capacity, operations queue there. Queries that touch that shard inherit its latency, while queries on other shards stay fast.",
    fix:
      "Reduce the write share that lands on the hot shard or add capacity to survive it. Rebalancing chunks without changing the key does not move the queue. Check whether reads can be served from secondaries or a different path.",
    checkFirst: [
      "Graph p99 per shard.",
      "Compare the hot shard's write rate with its modeled capacity.",
      "Check whether the tail follows the hot shard or the whole cluster.",
    ],
  },
  {
    id: "write-imbalance",
    metricId: "write-imbalance",
    warn: 3,
    crit: 6,
    title: "Write distribution is several times the average",
    cause:
      "The hottest shard receives a disproportionate share of writes. Balanced chunk counts only say that data volume is even; they say nothing about how many operations target each chunk.",
    fix:
      "Measure writes per shard and per key. If one key dominates, change the data model or key. If the key is monotonic, add a distribution prefix. Use the balancer for data volume, not for traffic concentration.",
    checkFirst: [
      "Compute writes per shard over the same window.",
      "Check the top key values by operation count.",
      "Check whether chunk counts and write counts disagree.",
    ],
  },
  {
    id: "chunk-skew",
    metricId: "chunk-skew",
    warn: 1.35,
    crit: 1.55,
    title: "Chunk counts are uneven",
    cause:
      "The balancer is disabled, behind, or blocked by a migration. This is a data-volume imbalance, which is a different problem from a hot key inside an evenly sized set of chunks.",
    fix:
      "Check balancer state and the migration window. Turn the balancer back on or give it time, but do not expect chunk migration to fix a hot key. A shard can have an even chunk count and still take most of the writes.",
    checkFirst: [
      "Check balancer state and the last migration result.",
      "Compare chunks per shard with writes per shard.",
      "Check for jumbo chunks or a failed migration.",
    ],
  },
];

export const hotShardModel: SimModel = {
  id: "mongodb-hot-shard",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(seed, values, 0);
    seedSeries(frame, values, 0, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values, frame.t);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.nodes.forEach((node, index) => {
      recordSeries(next, `cpu.${node.id}`, values.cpus[index] ?? 0);
    });
    if (values.hotCpu >= 90 && values.chunkSkew <= 1.35 && !Number(next.flags.balancedButHot ?? 0)) {
      pushEvent(next, {
        id: "balanced-but-hot",
        at: frame.t,
        severity: "crit",
        title: "Chunks are balanced; the hot key is not",
        detail: `The hot shard holds ${values.chunksOnHot.toFixed(0)} chunks against a ${values.chunkTarget.toFixed(0)} average, yet runs at ${values.hotCpu.toFixed(0)}% CPU. Moving chunks cannot split the key.`,
        nodeId: "shard-0",
        metricId: "hot-shard-cpu",
      });
      next.flags.balancedButHot = 1;
    }
    if (values.hotCpu < 90) next.flags.balancedButHot = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    return [
      `The write-hot shard is modeled at ${values.hotCpu.toFixed(0)}% CPU with ${values.chunksOnHot.toFixed(0)} chunks; the average shard has ${values.chunkTarget.toFixed(0)}. Chunk count measures data volume, not operation rate.`,
      `The write-hot shard carries ${(values.hottestShare * 100).toFixed(0)}% of writes, or ${values.imbalance.toFixed(1)}x the average. That concentration survives chunk migration because the key still routes there.`,
      values.keyPattern === 1
        ? "A monotonic key appends to the top chunk, so the newest writes always land on the shard that owns the top of the range."
        : "A hot key value lands on one shard regardless of how many chunks are balanced around it.",
      "Illustrative values only: four shards, 240 chunks, and 12,000 ops/s per shard are teaching numbers, not MongoDB limits.",
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
    description: "Even key distribution with an active balancer.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher write volume and a modest hot key.",
    tone: "warn",
    params: defaults({ writeRate: 24_000, hotKeyShare: 10, keyPattern: 0, balancerRate: 4 }),
  },
  {
    id: "failure",
    label: "Hot key",
    description: "One key takes 45% of writes while chunk counts stay close to even.",
    tone: "crit",
    params: defaults({ writeRate: 30_000, hotKeyShare: 45, keyPattern: 0, balancerRate: 2 }),
  },
  {
    id: "monotonic",
    label: "Monotonic key",
    description: "A timestamp-style key appends every write to the top chunk.",
    tone: "crit",
    params: defaults({ writeRate: 26_000, hotKeyShare: 0, keyPattern: 1, balancerRate: 4 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A distributed key spreads writes while the balancer keeps chunks even.",
    tone: "ok",
    params: defaults({ writeRate: 12_000, hotKeyShare: 0, keyPattern: 0, balancerRate: 4 }),
  },
];

const experiment: Experiment = {
  id: "predict-hot-shard",
  title: "Predict whether the balancer can fix a hot shard",
  simId: "hot-shard",
  question:
    "One shard runs at 80% CPU while the other three are near 20%. Chunk counts differ by less than 10%. Is the balancer broken?",
  prediction: {
    options: [
      { id: "yes", label: "Yes; balanced chunks mean the balancer has stopped moving data" },
      { id: "no", label: "No; a hot key or monotonic key keeps routing traffic to that shard" },
      { id: "shards", label: "Yes; the cluster needs more shards before the balancer can work" },
      { id: "config", label: "Yes; the config servers are not updating chunk metadata" },
    ],
    correctOptionId: "no",
    explanation:
      "Chunk count measures data volume. A hot key value or a monotonically increasing key can send most operations to one chunk on one shard while the balancer keeps chunk counts even. The balancer moves chunks; it cannot split a single key's traffic.",
  },
  setup: defaults({ writeRate: 30_000, hotKeyShare: 45, keyPattern: 0, balancerRate: 2 }),
  runFor: 30,
  observe: [
    "The hot shard's CPU stays near or above capacity while the others stay low.",
    "Chunk skew falls toward 1x as the balancer moves chunks, but CPU does not follow.",
    "The event says chunks are balanced while the hot key is not.",
    "Average shard CPU remains moderate, so a cluster average hides the saturated shard.",
  ],
  explain:
    "The balancer compares data volume per shard and moves whole chunks. If 45% of operations target one key, that key sits in one chunk on one shard. Moving the chunk moves the key and its traffic with it, and splitting chunks cannot split one key. The only fixes that change the load are changing the key distribution, splitting the hot value in the application, or adding capacity to survive it.",
  fix: defaults({ writeRate: 12_000, hotKeyShare: 0, keyPattern: 0, balancerRate: 4 }),
  debrief:
    "Check writes per shard and the hottest key values before touching the balancer. If chunk counts are even and CPU is not, the balancer is doing its job on the wrong metric. Record the key pattern and the top values, then choose a distribution fix. Turning the balancer off or moving the chunk will not reduce the hot key's traffic.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A hot shard is a shard that receives a disproportionate share of operations. The cluster can have balanced chunk counts and still have a hot shard, because chunks measure data volume while CPU and I/O follow operation rate. One key value, or a monotonically increasing range of values, can keep sending traffic to the same chunk.",
  },
  {
    type: "p",
    text: "The balancer moves chunks between shards when data volume differs beyond its migration threshold. It does not split a single key, and it does not route around a key that is hot. Moving the chunk that contains a hot key moves the key and its traffic together, so another shard becomes hot.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The shard key maps each document to a chunk; the chunk maps to a shard. mongos routes by that mapping. The balancer runs on the config server primary and changes the mapping over time. A hot shard is therefore a property of the key distribution and workload, not of the balancer's health.",
  },
  {
    type: "table",
    headers: ["Observation", "What it suggests", "What it does not prove"],
    rows: [
      ["One shard high CPU, chunks even", "Hot key or monotonic key", "That the balancer is broken"],
      ["One shard high CPU, chunks uneven", "Data-volume imbalance plus load skew", "Which of the two dominates"],
      ["Every shard high CPU", "Cluster-wide load or fan-out", "That one key is hot"],
      ["Chunk skew high, CPU even", "Balancer behind or disabled", "That queries are slow"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "Two different balances",
    body: "Chunk balance is about bytes. Write balance is about operations. A shard can own an even share of the data and still take most of the writes. The model's four shards, 240 chunks, and 12,000 ops/s per shard are illustrative values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot shard CPU: the saturation that users feel.",
      "Hot shard p99: queueing on the shard that owns the hot key.",
      "Write imbalance: the hottest shard compared with the average.",
      "Chunk-count skew: whether data volume is balanced, separately from load.",
      "Chunks on the hot shard and average shard CPU: the two numbers that expose the difference.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Hot key. Watch CPU saturate while chunk skew falls toward 1x. Compare that with Monotonic key, where chunks are even from the start and the top chunk still takes the writes. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "hot-shard" },
  { type: "experiment", experimentId: "predict-hot-shard" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "A small set of key values carried a large share of writes. The balancer moved chunks until the data volume looked even, but every operation for the hot value still routed to the same chunk on the same shard. CPU and p99 stayed high on that shard while the other shards had headroom.",
  },
  {
    type: "p",
    text: "Chunk skew improved, which made the dashboard look healthier without changing the user-visible tail. The event fired because the two signals disagreed: chunks were balanced, but writes were not. That disagreement is the diagnosis.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-shard CPU and write rate show one outlier, not a gradual cluster-wide rise.",
      "Chunk counts per shard are within the balancer's normal range.",
      "The hottest key values or the newest range dominate the write profile.",
      "Slow queries all touch the same shard or key range.",
      "The cluster average CPU and average p99 look acceptable.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check writes per shard before chunks per shard. If one shard is hot and chunk counts are even, inspect the key pattern and the top key values. If chunk counts are uneven too, separate data-volume imbalance from load skew. Only then decide whether the balancer or the key is the problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the hot shard with per-shard write rate and CPU.",
      "Check whether the key is monotonic or one value dominates.",
      "Change the distribution: bucket the hot key, use a compound key, or split the entity.",
      "If the key cannot change, add capacity to the hot shard or move reads away.",
      "Use the balancer for data volume, not as a load-balancing fix.",
      "Verify writes per shard and p99 after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Salting or bucketing a hot key spreads writes but complicates reads and aggregation.",
      "A compound key can add distribution but may weaken locality for other queries.",
      "Adding shards adds capacity but does not split one hot key.",
      "Moving the hot chunk shifts the hotspot and may make another shard the victim.",
      "Leaving the balancer off avoids migration load but lets data volume drift.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "balancer-or-key",
    question: "One shard is at 80% CPU and the others are idle, but chunks look balanced. How do you decide whether the balancer is broken?",
    difficulty: 3,
    hints: [
      "Chunks measure data, not operations.",
      "Check balancer state separately.",
      "Look for a hot key or monotonic pattern.",
    ],
    answer:
      "I would check balancer state and recent migration results to rule out an operational problem, then compare writes per shard with chunks per shard. If chunks are even and one shard takes most writes, the balancer is working on the wrong metric: a hot key or monotonic key is routing traffic to one chunk. I would inspect the hottest key values and the key pattern. Moving the chunk would move the same traffic, so the fix is to change the distribution or add capacity.",
    followUps: [
      "What would you check if chunks were also uneven?",
      "How would you prove a single key is hot?",
      "What does the balancer actually compare?",
    ],
    redFlags: [
      "Restarts the balancer without checking key distribution.",
      "Assumes balanced chunks mean balanced load.",
      "Adds shards without a key fix.",
    ],
    rubric: [
      "Checks balancer state.",
      "Compares writes with chunks.",
      "Names hot or monotonic key.",
      "Chooses a distribution or capacity fix.",
    ],
  },
  {
    id: "move-chunk",
    question: "Will moving the hot chunk to another shard fix the hotspot?",
    difficulty: 2,
    hints: [
      "The key goes with the chunk.",
      "One key cannot be split.",
      "Think about what changed.",
    ],
    answer:
      "It moves the hotspot, not the load. The hot key or hot range travels with the chunk, so the destination shard starts taking the same traffic. If the destination has more headroom, the symptom may pause, but the concentration remains. The durable fixes are to change the key distribution, split the hot value in the application, or add capacity to survive the concentration.",
    followUps: [
      "When could moving a chunk buy time?",
      "How would a bucket field change the picture?",
      "What if the hot value is a large tenant?",
    ],
    redFlags: [
      "Says the balancer splits the key.",
      "Believes moving data reduces operation rate.",
      "Ignores the destination shard.",
    ],
    rubric: [
      "Explains that the key moves with the chunk.",
      "Distinguishes load from placement.",
      "Names a durable fix.",
      "Considers the destination.",
    ],
  },
  {
    id: "hot-key-detection",
    question: "How would you detect a hot shard before users report slow queries?",
    difficulty: 3,
    hints: [
      "Per-shard, not cluster average.",
      "Writes and CPU together.",
      "Key-level evidence closes the case.",
    ],
    answer:
      "I would dashboard per-shard write rate, CPU, and p99, and alert on the maximum rather than the average. I would also track the top key values by operation count and the age of the newest range for monotonic keys. A useful alert is a large gap between the hottest shard and the median shard that persists across several windows. That catches the concentration before the hot shard saturates, and it distinguishes a hot key from a cluster-wide load increase.",
    followUps: [
      "What threshold would you use for the gap?",
      "How do you avoid alerting on a normal skew?",
      "What key-level metric is practical to collect?",
    ],
    redFlags: [
      "Alerts only on cluster average CPU.",
      "Uses chunk count as the primary signal.",
      "Waits for p99 to breach before investigating.",
    ],
    rubric: [
      "Uses per-shard maximum.",
      "Combines write rate, CPU, and p99.",
      "Adds key-level evidence.",
      "Distinguishes cluster-wide load.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboard write rate and CPU per shard, not only cluster averages.",
      "Track the top key values and whether the key is monotonic.",
      "Know the balancer state and the migration window.",
      "Document which workloads can tolerate a key change.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare writes per shard with chunks per shard.",
      "Check whether one key or the newest range dominates.",
      "Check balancer state before changing it.",
      "Do not assume a chunk move will reduce load.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify writes per shard and p99 improved, not only chunk skew.",
      "Record the hot key or range and the chosen fix.",
      "Review whether the key still fits the workload.",
      "Plan capacity for legitimate concentrated tenants.",
    ],
  },
];

const references = [
  {
    title: "Sharding",
    url: "https://www.mongodb.com/docs/manual/sharding/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Sharded cluster behavior and shard key distribution.",
  },
  {
    title: "Sharded Cluster Balancer",
    url: "https://www.mongodb.com/docs/manual/core/sharding-balancer-administration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "What the balancer compares, migration thresholds, and chunk migration.",
  },
  {
    title: "Shard Keys",
    url: "https://www.mongodb.com/docs/manual/core/sharding-shard-key/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Cardinality, frequency, monotonicity, and hot key behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-shard": {
      model: hotShardModel,
      presets,
      instructions:
        "Start Healthy, then apply Hot key. Watch CPU saturate while chunk skew falls. Compare Monotonic key, then use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. Four shards, 240 chunks, 12,000 ops/s per shard, and the balancer decay are teaching values, not MongoDB limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-shard-key", "mongodb-sharding", "mongodb-chunk-migration"],
};
