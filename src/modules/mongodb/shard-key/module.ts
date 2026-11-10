import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 4;
const SHARD_CAPACITY_OPS = 12_000;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "keyPattern",
    label: "Key pattern",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Candidate",
    help: "0 = ranged random, 1 = ranged monotonic, 2 = hashed. The model uses four shards; a real key choice must be tested against the actual query shapes.",
    format: "count",
  },
  {
    id: "distinctKeys",
    label: "Distinct key values",
    min: 100,
    max: 1_000_000,
    step: 1_000,
    value: 500_000,
    unit: "",
    group: "Cardinality",
    help: "Number of distinct values available to split. Low cardinality limits how finely chunks can divide.",
    format: "count",
  },
  {
    id: "rangeShare",
    label: "Range-query share",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Query shape",
    help: "Share of reads that use a range predicate on the candidate key. Range predicates need ordered ranges; a hashed key cannot serve them as a targeted scan.",
    format: "percent",
  },
  {
    id: "writeRate",
    label: "Operation rate",
    min: 2_000,
    max: 30_000,
    step: 1_000,
    value: 6_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Writes and reads that exercise the key. Illustrative capacity is 12,000 ops/s per shard.",
    format: "rps",
  },
  {
    id: "hotKeyShare",
    label: "Traffic on the most frequent key",
    min: 0,
    max: 40,
    step: 1,
    value: 0,
    unit: "%",
    group: "Cardinality",
    help: "Share of operations aimed at one key value. A single hot value lands on one shard no matter how high the cardinality is.",
    format: "percent",
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
  keyPattern: number;
  distinctKeys: number;
  rangeShare: number;
  writeRate: number;
  hotKeyShare: number;
  hottestShare: number;
  imbalance: number;
  fanout: number;
  queryP99: number;
  hotCpu: number;
  avgCpu: number;
  hotShardIndex: number;
  writes: number[];
  cpus: number[];
}

function compute(p: Params): Computed {
  const keyPattern = Math.round(clamp(num(p, "keyPattern", 0), 0, 2));
  const distinctKeys = clamp(num(p, "distinctKeys", 500_000), 100, 1_000_000);
  const rangeShare = clamp(num(p, "rangeShare", 20), 0, 100) / 100;
  const writeRate = clamp(num(p, "writeRate", 6_000), 0, 30_000);
  const hotKeyShare = clamp(num(p, "hotKeyShare", 0), 0, 40) / 100;
  const cardinalityPenalty = distinctKeys < 1_000 ? (1 - distinctKeys / 1_000) * 0.25 : 0;
  const monotonicPenalty = keyPattern === 1 ? 0.38 : 0;
  const hottestShare = clamp(0.25 + hotKeyShare * 0.65 + monotonicPenalty + cardinalityPenalty, 0.25, 0.98);
  const imbalance = hottestShare * SHARD_COUNT;
  const fanout =
    keyPattern === 2
      ? 1 + rangeShare * (SHARD_COUNT - 1)
      : 1 + rangeShare * (SHARD_COUNT - 1) * 0.25;
  const hotCpu = (writeRate * hottestShare * 100) / SHARD_CAPACITY_OPS;
  const avgCpu = (writeRate * 100) / (SHARD_COUNT * SHARD_CAPACITY_OPS);
  const util = Math.min(0.97, hotCpu / 100);
  const queryP99 = Math.min(
    MAX_P99_MS,
    4 + fanout * 3 + (80 * util) / (1 - util) + (keyPattern === 2 ? rangeShare * 15 : 0),
  );
  const hotShardIndex = keyPattern === 1 ? SHARD_COUNT - 1 : 0;
  const hotWrites = writeRate * hottestShare;
  const otherWrites = (writeRate - hotWrites) / (SHARD_COUNT - 1);
  const writes = Array.from({ length: SHARD_COUNT }, (_, index) => (index === hotShardIndex ? hotWrites : otherWrites));
  const cpus = writes.map((value) => (value * 100) / SHARD_CAPACITY_OPS);
  return {
    keyPattern,
    distinctKeys,
    rangeShare,
    writeRate,
    hotKeyShare,
    hottestShare,
    imbalance,
    fanout,
    queryP99,
    hotCpu,
    avgCpu,
    hotShardIndex,
    writes,
    cpus,
  };
}

function healthFor(cpu: number, p99: number): Health {
  if (cpu >= 90 || p99 >= 120) return "crit";
  if (cpu >= 70 || p99 >= 50) return "warn";
  return "ok";
}

function patternLabel(keyPattern: number): string {
  return keyPattern === 1 ? "ranged monotonic" : keyPattern === 2 ? "hashed" : "ranged random";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const nodes: SimNode[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const cpu = values.cpus[index] ?? 0;
    const isHot = index === values.hotShardIndex;
    const p99 = isHot ? values.queryP99 : Math.min(values.queryP99, 8 + cpu * 1.2);
    return {
      id: `shard-${index}`,
      label: `Shard ${index}`,
      kind: "db" as const,
      role: "shard" as const,
      health: healthFor(cpu, p99),
      utilization: clamp(cpu / 100),
      throughput: values.writes[index] ?? 0,
      sublabel: isHot ? "highest write share" : `${(cpu).toFixed(0)}% CPU`,
      detail: `${(values.writes[index] ?? 0).toFixed(0)} ops/s, ${cpu.toFixed(0)}% CPU. The key pattern is ${patternLabel(values.keyPattern)}; the hottest shard holds ${(values.hottestShare * 100).toFixed(0)}% of modeled operations.`,
      meta: { view: "shards", cpu, memory: 8 + values.writeRate / 5_000, p99, hot: cpu >= 70 ? 1 : 0 },
    };
  });

  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("hot-shard-cpu", "Hot shard CPU", values.hotCpu, "%", 70, 90, "percent"),
      metric("query-p99", "Query p99", values.queryP99, "ms", 50, 120, "ms"),
      metric("fanout", "Shards touched per query", values.fanout, "", 2, 3.5, "number"),
      metric("shard-imbalance", "Write imbalance", values.imbalance, "x", 2.5, 3.5, "number"),
      metric("avg-shard-cpu", "Average shard CPU", values.avgCpu, "%", undefined, undefined, "percent"),
      metric("hot-key-share", "Traffic on hottest key", values.hotKeyShare * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, keyPattern: values.keyPattern, rangeShare: values.rangeShare },
    summary: `${patternLabel(values.keyPattern)} key · hottest shard ${values.hotCpu.toFixed(0)}% CPU · imbalance ${values.imbalance.toFixed(1)}x · ${values.fanout.toFixed(1)} shards per query.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 6)) / 2.4);
  const rows: [string, number][] = [
    ["hot-shard-cpu", values.hotCpu],
    ["query-p99", values.queryP99],
    ["fanout", values.fanout],
    ["shard-imbalance", values.imbalance],
    ["avg-shard-cpu", values.avgCpu],
    ["hot-key-share", values.hotKeyShare * 100],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.nodes.forEach((node, index) => {
    const cpu = values.cpus[index] ?? 0;
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, point) =>
      Math.max(0, cpu * jitter(point)),
    );
  });
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-cpu",
    metricId: "hot-shard-cpu",
    warn: 70,
    crit: 90,
    title: "The shard key sends most writes to one shard",
    cause:
      "A monotonically increasing ranged key always appends to the chunk at the top of the range, so new writes collect on one shard. A hot key value does the same even with high cardinality. The balancer moves whole chunks; it cannot split one key's traffic.",
    fix:
      "Choose a key with high cardinality, low frequency, and a distribution that matches writes, such as a compound key with a tenant or bucket prefix. Hashed keys spread writes but cost range-query locality. Test the candidate against real query shapes before resharding.",
    checkFirst: [
      "Compare per-shard write rates and CPU, not the cluster average.",
      "Check whether the key is monotonically increasing, such as a timestamp or ObjectId.",
      "Check the most frequent key values and their share of traffic.",
    ],
  },
  {
    id: "query-p99",
    metricId: "query-p99",
    warn: 50,
    crit: 120,
    title: "Queueing follows the hot shard into the query tail",
    cause:
      "The hottest shard is near or above its modeled capacity, so reads that touch it queue behind writes. A hashed key can avoid that and still add scatter-gather cost for range queries.",
    fix:
      "Separate the two costs: measure the hot shard's CPU and the number of shards touched. Fix a hotspot with the key distribution; fix scatter-gather with query targeting or an index that supports the predicate.",
    checkFirst: [
      "Check p99 per shard and per query shape.",
      "Check whether the slow query touches one shard or many.",
      "Check for a recent change in key pattern or load.",
    ],
  },
  {
    id: "fanout",
    metricId: "fanout",
    warn: 2,
    crit: 3.5,
    title: "The key choice makes range queries broadcast",
    cause:
      "A hashed shard key distributes writes evenly but destroys the ordering that range queries need. A range predicate must be sent to every shard, and mongos merges the results. High cardinality does not create locality.",
    fix:
      "If range queries matter, use a ranged key with a distribution prefix, or accept the fan-out and bound its cost. A compound key can preserve locality for the dominant predicate while adding enough cardinality to split.",
    checkFirst: [
      "Check whether range predicates appear in the top query shapes.",
      "Check the key pattern and whether it preserves order.",
      "Check shards touched for the range query, not only its average latency.",
    ],
  },
  {
    id: "shard-imbalance",
    metricId: "shard-imbalance",
    warn: 3,
    crit: 6,
    title: "Write distribution is several times the average",
    cause:
      "The hottest shard receives a disproportionate share of operations. High cardinality alone does not prevent this: a monotonic key or one frequent value can dominate traffic.",
    fix:
      "Pick a key that spreads the write pattern and still supports the main lookup. Consider a compound key, a bucket field, or a hashed key if range locality is not required. Resharding is a separate, expensive operation.",
    checkFirst: [
      "Compute writes per shard, not chunks per shard.",
      "Check cardinality and frequency together.",
      "Check whether the application writes to a small set of key values.",
    ],
  },
];

export const shardKeyModel: SimModel = {
  id: "mongodb-shard-key",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.nodes.forEach((node, index) => {
      recordSeries(next, `cpu.${node.id}`, values.cpus[index] ?? 0);
    });
    if (values.keyPattern === 2 && values.rangeShare > 0 && !Number(next.flags.scatterAnnounced ?? 0)) {
      pushEvent(next, {
        id: "hashed-range-scatter",
        at: frame.t,
        severity: values.fanout >= 3.5 ? "crit" : "warn",
        title: "Hashed key turns range reads into fan-out",
        detail: `The hashed key distributes writes, but ${(values.rangeShare * 100).toFixed(0)}% range queries touch ${values.fanout.toFixed(1)} shards on average.`,
        metricId: "fanout",
      });
      next.flags.scatterAnnounced = 1;
    }
    if (values.keyPattern !== 2 || values.rangeShare <= 0) next.flags.scatterAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `A ${patternLabel(values.keyPattern)} key gives a hottest-shard share of ${(values.hottestShare * 100).toFixed(0)}%, or ${values.imbalance.toFixed(1)}x the average shard.`,
      `Average shard CPU is ${values.avgCpu.toFixed(0)}% while the hot shard is ${values.hotCpu.toFixed(0)}%. The average says there is room; the maximum says where the work is.`,
      `Range queries touch ${values.fanout.toFixed(1)} shards on average. A hashed key spreads writes evenly but cannot preserve the ordering a range scan needs.`,
      "Cardinality, frequency, and query shape are three separate tests. A key can pass cardinality and still fail frequency or locality. The numbers here are illustrative.",
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
    description: "A ranged random key spreads writes and keeps range queries local.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A busy workload with a modest key frequency and mixed range reads.",
    tone: "warn",
    params: defaults({ writeRate: 18_000, hotKeyShare: 5, rangeShare: 40 }),
  },
  {
    id: "failure",
    label: "Monotonic key",
    description: "A timestamp-style key appends every write to the last shard.",
    tone: "crit",
    params: defaults({ keyPattern: 1, writeRate: 30_000, hotKeyShare: 10, rangeShare: 20 }),
  },
  {
    id: "scatter",
    label: "Hashed range",
    description: "A hashed key fixes write distribution but every range query broadcasts.",
    tone: "crit",
    params: defaults({ keyPattern: 2, writeRate: 16_000, rangeShare: 100, hotKeyShare: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A hashed key with equality lookups spreads writes without range fan-out.",
    tone: "ok",
    params: defaults({ keyPattern: 2, writeRate: 8_000, rangeShare: 0, hotKeyShare: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-shard-key",
  title: "Predict the cost of a perfectly distributed hashed key",
  simId: "shard-key",
  question:
    "The team switches from a monotonically increasing timestamp key to a hashed `_id` key. Writes become even across shards. The main report filters a timestamp range. What happens to that report?",
  prediction: {
    options: [
      { id: "fast", label: "It gets faster because writes no longer queue on one shard" },
      { id: "same", label: "It is unchanged because hashing preserves range order" },
      { id: "scatter", label: "It scatters to every shard because hashing destroys range locality" },
      { id: "fail", label: "It fails because a hashed key cannot be queried" },
    ],
    correctOptionId: "scatter",
    explanation:
      "A hashed key distributes values evenly, but the hash order is unrelated to timestamp order. A range on the original field cannot be mapped to one contiguous set of chunks, so mongos must ask every shard. Equality lookups on the hashed key remain targeted.",
  },
  setup: defaults({ keyPattern: 2, writeRate: 16_000, rangeShare: 100, hotKeyShare: 0 }),
  runFor: 20,
  observe: [
    "Write imbalance returns to about 1x and the hot-shard CPU falls.",
    "Shards touched per query rises to the number of shards.",
    "Average shard CPU looks comfortable while the query p99 rises.",
    "The slow report is slow for a different reason than before: fan-out, not a write hotspot.",
  ],
  explain:
    "A shard key is a compromise between distributing writes and preserving the locality the dominant reads need. Hashed keys optimize distribution and equality targeting; ranged keys preserve order and range locality but are vulnerable to monotonic inserts. High cardinality is necessary but not sufficient. The fix is to choose a key for the whole workload, not one metric.",
  fix: defaults({ keyPattern: 0, writeRate: 16_000, rangeShare: 100, hotKeyShare: 0 }),
  debrief:
    "Measure writes per shard and shards touched per query before and after any key change. A key that fixes one and breaks the other is a trade, not a free improvement. If the report is critical, consider a compound key with a distribution prefix or a separate read model; if it is occasional, accept the fan-out and bound its cost.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A shard key is the field or fields MongoDB uses to partition a collection. It determines which chunk, and therefore which shard, owns a document. A good key spreads writes, keeps the hot queries targeted, and has enough distinct values to split into manageable chunks.",
  },
  {
    type: "p",
    text: "Those goals conflict. A monotonically increasing ranged key such as a timestamp preserves order and supports range scans, but every new write lands at the top of the range. A hashed key spreads writes evenly but destroys order, so a range query must visit every shard. Cardinality is necessary but not sufficient: one very frequent value still lands on one shard.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The key is declared when the collection is sharded. mongos uses it to map a predicate to chunk ranges and shards. The balancer moves chunks, not individual keys, so a hot key inside a chunk stays hot even when chunk counts look even. Changing the key later requires resharding or a new collection and migration.",
  },
  {
    type: "compare",
    leftTitle: "Ranged key",
    rightTitle: "Hashed key",
    rows: [
      { label: "Write distribution", left: "Even only if values are not monotonic", right: "Even by construction" },
      { label: "Range queries", left: "Targeted to the relevant ranges", right: "Fan out to every shard" },
      { label: "Equality lookups", left: "Targeted", right: "Targeted" },
      { label: "Main risk", left: "Monotonic hotspot or low cardinality", right: "Scatter-gather for range reads" },
      { label: "Ordering", left: "Preserved", right: "Destroyed by the hash" },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "Three tests, not one",
    body: "Test cardinality, frequency, and query shape. High cardinality does not stop a hot value, and even distribution does not create query locality. The model's four shards and 12,000 ops/s per shard are illustrative teaching values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot shard CPU: concentration of modeled write work.",
      "Write imbalance: hottest shard compared with the average.",
      "Shards touched per query: whether the key supports targeting.",
      "Query p99: queueing on the hot shard plus fan-out cost.",
      "Average shard CPU: the number that can hide a hot partition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Monotonic key and watch one shard absorb the writes. Apply Hashed range and watch the hotspot disappear while fan-out rises. Compare the two failures: one is a write distribution problem, the other is a query locality problem. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "shard-key" },
  { type: "experiment", experimentId: "predict-shard-key" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The monotonic ranged key appended new writes to the top chunk, so one shard carried most of the write load while the other shards had capacity. Switching to a hashed key spread the writes, but range queries could no longer be mapped to ordered ranges, so mongos sent them to every shard. The hotspot disappeared and the query tail moved to fan-out.",
  },
  {
    type: "p",
    text: "Neither key was universally better. The first optimized range locality and failed write distribution; the second optimized distribution and failed range locality. A compound key or a separate read path can reduce the conflict, but it adds its own constraints.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "One shard has much higher CPU and write rate than its peers, while chunk counts look even.",
      "The hottest key values or the newest range accounts for a large share of operations.",
      "A hashed key shows even write rates but high shards-touched for range queries.",
      "The cluster average CPU looks healthy in both failures.",
      "Resharding progress and chunk migration add their own load during a key change.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check writes per shard and shards touched per query together. If one shard is hot, inspect key monotonicity, cardinality, and the most frequent values. If every shard is busy for one query, inspect the predicate and whether the key preserves order. Do not judge the key by chunk count alone.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the dominant writes and reads with their predicates.",
      "Test cardinality, frequency, and locality for each candidate key.",
      "Prefer a compound key that includes the dominant query field and a distribution prefix.",
      "If changing the key, plan resharding or a new collection and backfill.",
      "Measure writes per shard and shards touched after the change.",
      "Revisit the choice when the workload or query mix changes.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Hashed keys distribute writes but make range queries broadcast.",
      "Ranged keys preserve locality but are vulnerable to monotonic inserts and hot values.",
      "Compound keys can serve more query shapes but make every predicate depend on the prefix order.",
      "Resharding fixes the key later at the cost of data movement and temporary load.",
      "A separate read model can protect a report without changing the write key, but it adds a pipeline to operate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-key",
    question: "How do you choose a shard key for a collection with tenant lookups and timestamp reports?",
    difficulty: 4,
    hints: [
      "Start with the query shapes.",
      "Cardinality is not the only test.",
      "Consider a compound key.",
    ],
    answer:
      "I would list the dominant writes, tenant lookups, and timestamp range reports. A compound key such as tenant identifier plus timestamp can give targeted tenant queries and ordered recent data within a tenant, while the tenant prefix adds cardinality. I would check the frequency of the tenant values, because one huge tenant can still create a hot shard. I would also check whether the report spans tenants; if it does, some fan-out is unavoidable. Then I would test the candidate on realistic data and plan for resharding if the workload changes.",
    followUps: [
      "What if one tenant is 40% of traffic?",
      "How does the compound key affect range reports across tenants?",
      "What would make you choose a hashed key instead?",
    ],
    redFlags: [
      "Chooses a key by cardinality alone.",
      "Ignores the dominant query shape.",
      "Assumes the balancer fixes a hot key.",
    ],
    rubric: [
      "Starts from query shapes.",
      "Tests cardinality and frequency.",
      "Considers a compound key.",
      "Names the remaining fan-out or hotspot.",
    ],
  },
  {
    id: "monotonic",
    question: "Why does an ObjectId or timestamp shard key create a hot shard?",
    difficulty: 2,
    hints: [
      "New values sort at one end.",
      "One chunk owns the top of the range.",
      "The balancer moves chunks, not individual writes.",
    ],
    answer:
      "A monotonically increasing key always produces values above the current maximum, so new writes land in the chunk that owns the top of the key range. That chunk lives on one shard. The balancer can move chunks after they grow, but it cannot spread the newest writes across shards, and it cannot split one key. The result is one shard taking most insert traffic while chunk counts may look balanced.",
    followUps: [
      "How would a hashed key change this?",
      "What is a bucket field?",
      "Why can chunk counts look balanced while CPU is not?",
    ],
    redFlags: [
      "Says the balancer spreads every write.",
      "Confuses chunk count with write rate.",
      "Ignores the top-of-range chunk.",
    ],
    rubric: [
      "Explains top-of-range concentration.",
      "Distinguishes chunks from writes.",
      "Names the balancer's limit.",
      "Offers a distribution fix.",
    ],
  },
  {
    id: "hashed-range",
    question: "A hashed shard key gives perfect write distribution. Why are range queries slow?",
    difficulty: 3,
    hints: [
      "Hash order is not value order.",
      "A range cannot be mapped to contiguous chunks.",
      "Every shard must be asked.",
    ],
    answer:
      "A hashed key stores values by hash, so values that are adjacent in the original field are scattered across the key space. A range predicate on that field cannot be mapped to a small set of contiguous chunks, so mongos has to send the query to every shard and merge the results. Equality lookups on the hashed key are still targeted. The fix is to accept the fan-out, add capacity, or choose a ranged or compound key that preserves the range locality the workload needs.",
    followUps: [
      "Which queries remain targeted with a hashed key?",
      "How would a compound key change the plan?",
      "What would you measure to prove the cause?",
    ],
    redFlags: [
      "Says hashing preserves order.",
      "Blames the config servers.",
      "Adds shards without checking fan-out.",
    ],
    rubric: [
      "Explains hash order.",
      "Predicts fan-out for ranges.",
      "Keeps equality targeted.",
      "Names a tradeoff-aware fix.",
    ],
  },
  {
    id: "hot-key",
    question: "Cardinality is one million, but one key is 30% of traffic. Is the shard key good?",
    difficulty: 3,
    hints: [
      "Cardinality counts values, not their frequency.",
      "One key lands on one shard.",
      "The balancer cannot split a key.",
    ],
    answer:
      "High cardinality does not help if one value dominates traffic. All operations for that key land on the shard that owns its chunk, so that shard can saturate while the other million values sit elsewhere. I would check the frequency distribution, not just the distinct count. The fix might be a compound key that splits the hot value, an application change to spread the hot key, or a different data model for that entity.",
    followUps: [
      "How would you detect the hot value?",
      "Can a compound key split one key's traffic?",
      "What if the hot value is a legitimate large tenant?",
    ],
    redFlags: [
      "Equates cardinality with even distribution.",
      "Assumes the balancer splits a single key.",
      "Ignores frequency.",
    ],
    rubric: [
      "Separates cardinality from frequency.",
      "Locates the hot key on one shard.",
      "Names the balancer limit.",
      "Suggests a data-model fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before choosing a key",
    items: [
      "List the top writes and reads with their predicates.",
      "Check cardinality and the frequency of the largest values.",
      "Check whether range queries need ordering.",
      "Test the candidate on realistic data and query shapes.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare writes and CPU per shard, not chunk counts.",
      "Check shards touched for the slow query.",
      "Check whether the key is monotonic or one value is hot.",
      "Do not turn off the balancer as the first response.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the fix improved both distribution and query targeting.",
      "Document the remaining fan-out or hotspot.",
      "Plan key changes as resharding projects.",
      "Revisit the key when the workload mix changes.",
    ],
  },
];

const references = [
  {
    title: "Shard Keys",
    url: "https://www.mongodb.com/docs/manual/core/sharding-shard-key/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Shard key concepts, cardinality, frequency, and monotonicity.",
  },
  {
    title: "Choose a Shard Key",
    url: "https://www.mongodb.com/docs/manual/core/sharding-choose-a-shard-key/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Tradeoffs between distribution and query targeting.",
  },
  {
    title: "Hashed Sharding",
    url: "https://www.mongodb.com/docs/manual/core/hashed-sharding/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Hashed shard keys, distribution, and query behavior.",
  },
  {
    title: "Ranged Sharding",
    url: "https://www.mongodb.com/docs/manual/core/ranged-sharding/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Ranged shard keys and range-query targeting.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "shard-key": {
      model: shardKeyModel,
      presets,
      instructions:
        "Start Healthy, then apply Monotonic key. Watch one shard absorb writes, then apply Hashed range and compare fan-out. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. Four shards, 12,000 ops/s per shard, and the distribution curves are teaching values, not MongoDB limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-sharding", "mongodb-hot-shard", "mongodb-chunk-migration"],
};
