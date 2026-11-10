import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "writesPerSecond",
    label: "Cluster write rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 6_000,
    unit: " writes/s",
    group: "Workload",
    help: "Total inserts and updates across every tenant. The average is not what saturates a partition.",
    format: "rps" as const,
  },
  {
    id: "hotTenantShare",
    label: "Hot tenant share",
    min: 10,
    max: 80,
    step: 5,
    value: 25,
    unit: "%",
    group: "Workload",
    help: "Share of all writes produced by the largest tenant. This is the skew the partition key must absorb.",
    format: "percent" as const,
  },
  {
    id: "partitions",
    label: "Partitions",
    min: 4,
    max: 16,
    step: 1,
    value: 8,
    unit: "",
    group: "Schema",
    help: "Number of physical partitions behind the logical table. More partitions add capacity only if the key spreads across them.",
    format: "count" as const,
  },
  {
    id: "partitionCapacity",
    label: "Capacity per partition",
    min: 500,
    max: 8_000,
    step: 250,
    value: 2_500,
    unit: " writes/s",
    group: "Capacity",
    help: "Sustained write capacity one partition can absorb before latency rises. Illustrative, not a DynamoDB or PostgreSQL limit.",
    format: "rps" as const,
  },
  {
    id: "spreadHotTenant",
    label: "Spread hot tenant key",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Schema",
    help: "0 keys by tenant id, so one tenant maps to one partition. 1 adds a bucket suffix that spreads that tenant across up to four partitions.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  total: number;
  hotShare: number;
  partitions: number;
  capacity: number;
  spread: boolean;
  hotParts: number;
  hotLoad: number;
  otherLoad: number;
  maxLoad: number;
  medianLoad: number;
  maxUtilization: number;
  skew: number;
  headroom: number;
  health: Health;
}

function compute(p: Params): Computed {
  const total = Math.max(0, num(p, "writesPerSecond", 6_000));
  const hotShare = clamp(num(p, "hotTenantShare", 25) / 100, 0, 1);
  const partitions = Math.max(1, Math.round(num(p, "partitions", 8)));
  const capacity = Math.max(1, num(p, "partitionCapacity", 2_500));
  const spread = num(p, "spreadHotTenant", 0) >= 0.5;
  const hotParts = spread ? Math.min(partitions, 4) : 1;
  const hotLoad = (total * hotShare) / hotParts;
  const otherLoad = partitions > 1 ? (total * (1 - hotShare)) / (partitions - 1) : 0;
  const loads = Array.from({ length: partitions }, (_, index) => (index < hotParts ? hotLoad : otherLoad));
  const sorted = [...loads].sort((a, b) => a - b);
  const maxLoad = sorted[sorted.length - 1] ?? 0;
  const medianLoad = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const maxUtilization = (maxLoad / capacity) * 100;
  const skew = maxLoad / Math.max(1, medianLoad);
  const health: Health = maxUtilization >= 100 ? "crit" : maxUtilization >= 80 ? "warn" : "ok";
  return {
    total,
    hotShare,
    partitions,
    capacity,
    spread,
    hotParts,
    hotLoad,
    otherLoad,
    maxLoad,
    medianLoad,
    maxUtilization,
    skew,
    headroom: Math.max(0, capacity - maxLoad),
    health,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  for (let index = 0; index < values.partitions; index++) {
    const load = index < values.hotParts ? values.hotLoad : values.otherLoad;
    const base = Math.min(100, (load / values.capacity) * 100);
    frame.series[`cpu.p${index + 1}`] = Array.from({ length: 20 }, (_, point) =>
      clamp((base + Math.sin((point + (seed % 5)) / 2.3) * 4) / 100) * 100,
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const nodes = Array.from({ length: values.partitions }, (_, index) => {
    const hot = index < values.hotParts;
    const load = hot ? values.hotLoad : values.otherLoad;
    const utilization = load / values.capacity;
    const health: Health = utilization >= 1 ? "crit" : utilization >= 0.8 ? "warn" : "ok";
    return {
      id: `p${index + 1}`,
      label: hot && values.hotParts === 1 ? `Partition ${index + 1} · hot` : `Partition ${index + 1}`,
      kind: "db" as const,
      role: "shard" as const,
      health,
      utilization: clamp(utilization),
      throughput: Math.round(load),
      capacity: Math.round(values.capacity),
      sublabel: `${formatCount(load)} writes/s · ${Math.round(utilization * 100)}%`,
      detail: hot
        ? "This partition receives the largest tenant's traffic. Its ceiling, not the cluster average, sets the safe write rate."
        : "This partition is below capacity. Idle capacity here cannot absorb load from another partition unless the key is split.",
      meta: { view: "shards", writes: Math.round(load), capacity: values.capacity },
    };
  });
  return {
    t: 0,
    nodes,
    edges: [edge("table-partitions", "p1", `p${values.partitions}`, clamp(values.total / 20_000), values.health, "key routing")],
    metrics: [
      metric("hot-utilization", "Hottest partition", values.maxUtilization, "%", 80, 100, "percent"),
      metric("skew", "Skew (hottest / median)", values.skew, "x", 3, 6, "number"),
      metric("headroom", "Headroom on hottest", values.headroom, " writes/s", undefined, undefined, "rps"),
      metric("write-rate", "Cluster write rate", values.total, " writes/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.partitions} partitions; hottest is ${Math.round(values.maxUtilization)}% used at ${formatCount(
      values.maxLoad,
    )} writes/s; skew ${values.skew.toFixed(1)}x.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-utilization",
    metricId: "hot-utilization",
    warn: 80,
    crit: 100,
    title: "The hottest partition is over capacity",
    cause:
      "Partition capacity is consumed by the busiest key range. Total cluster headroom does not help because the overloaded key cannot use another partition's capacity.",
    fix:
      "Spread the hot tenant across buckets, isolate it on dedicated capacity, or archive old rows. Adding partitions without changing the key leaves the hot range where it was.",
    checkFirst: [
      "Compare per-partition write rate with the hottest partition's ceiling.",
      "Check whether one tenant or key range produces most of the writes.",
      "Check whether the key includes a bucket suffix or only a tenant id.",
    ],
  },
  {
    id: "skew",
    metricId: "skew",
    warn: 3,
    crit: 6,
    title: "Write distribution is skewed",
    cause:
      "A key that includes a low-cardinality tenant id sends all of that tenant's rows to one partition. The median partition looks healthy while the hottest one queues.",
    fix:
      "Add entropy to the write key for the hot tenant, use a dedicated partition or table for that tenant, or split by time if the access pattern allows it.",
    checkFirst: [
      "Rank partitions by write rate and compare the top with the median.",
      "Check the tenant distribution, not just the total row count.",
      "Confirm that read queries can still find rows after the key changes.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const partitionModel: SimModel = {
  id: "databases-hot-partitions",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const node of next.nodes) {
      recordSeries(next, `cpu.${node.id}`, (node.utilization ?? 0) * 100);
    }
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.maxUtilization >= 100 && frame.flags.saturatedLogged !== 1) {
      pushEvent(next, {
        id: "partition-saturated",
        at: frame.t,
        severity: "crit",
        title: "One partition is saturated",
        detail: `The hottest partition carries ${formatCount(values.maxLoad)} writes/s against ${formatCount(
          values.capacity,
        )} capacity, while the median partition carries ${formatCount(values.medianLoad)}.`,
        nodeId: "p1",
        metricId: "hot-utilization",
      });
    }
    next.flags.saturatedLogged = values.maxUtilization >= 100 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The hottest partition carries ${formatCount(values.maxLoad)} writes/s (${Math.round(
        values.maxUtilization,
      )}% of ${formatCount(values.capacity)}). The median partition carries ${formatCount(values.medianLoad)}.`,
      `Skew is ${values.skew.toFixed(1)}x. The cluster average hides it: total writes divided by ${values.partitions} partitions would suggest ${formatCount(
        values.total / values.partitions,
      )} writes/s per partition.`,
      values.spread
        ? `The tenant key is spread across ${values.hotParts} bucket partitions, so the largest tenant's writes are divided before they reach a partition.`
        : "The tenant key is not bucketed, so the largest tenant's writes land on one partition. Additional partitions do not split that key range.",
      `Headroom on the hottest partition is ${formatCount(values.headroom)} writes/s. Zero means overload; idle capacity on another partition cannot absorb it.`,
      "Disk follows the same distribution. A hot partition can fill its volume while other partitions have free space.",
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
    description: "A moderate tenant share across eight partitions leaves the hottest one at 60%.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Higher total writes push the hottest partition to 90% and skew to about 3x.",
    tone: "warn",
    params: defaults({ writesPerSecond: 9_000, hotTenantShare: 30, partitionCapacity: 3_000 }),
  },
  {
    id: "failure",
    label: "Hot tenant",
    description: "One tenant produces 60% of writes and lands on a single partition, which runs at 192% of capacity.",
    tone: "crit",
    params: defaults({ writesPerSecond: 8_000, hotTenantShare: 60, partitions: 8, partitionCapacity: 2_500 }),
  },
  {
    id: "spread",
    label: "Bucketed hot tenant",
    description: "The same tenant share is spread across four buckets on twelve partitions.",
    tone: "ok",
    params: defaults({
      writesPerSecond: 8_000,
      hotTenantShare: 40,
      partitions: 12,
      partitionCapacity: 3_000,
      spreadHotTenant: 1,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Buckets and dedicated capacity bring the hottest partition back under 30%.",
    tone: "ok",
    params: defaults({
      writesPerSecond: 8_000,
      hotTenantShare: 50,
      partitions: 12,
      partitionCapacity: 6_000,
      spreadHotTenant: 1,
    }),
  },
];

const experiment: Experiment = {
  id: "split-the-tenant",
  title: "Fix the hot partition without adding a node",
  simId: "hot-partitions",
  question:
    "One tenant produces 60% of writes and its partition is at 192% of capacity. Adding four more partitions changes nothing. What actually reduces the hottest partition's load?",
  prediction: {
    options: [
      { id: "more-partitions", label: "Add four more partitions to the table." },
      { id: "bigger-node", label: "Raise capacity on every partition by 50%." },
      { id: "spread-key", label: "Spread the hot tenant across buckets or isolate it on dedicated capacity." },
      { id: "archive", label: "Archive rows older than a year from every tenant." },
    ],
    correctOptionId: "spread-key",
    explanation:
      "Adding partitions does not split a tenant id that maps to one key range, so the hot partition keeps receiving the same writes. A larger partition raises the ceiling but does not change the distribution, and archival only helps if the hot tenant's old rows are the write source. Spreading the key across buckets or giving the tenant dedicated capacity changes where the writes land.",
  },
  setup: defaults({ writesPerSecond: 8_000, hotTenantShare: 60, partitions: 12, partitionCapacity: 2_500 }),
  runFor: 20,
  observe: [
    "Twelve partitions are visible, but one still carries 4,800 writes/s.",
    "The hottest partition is at 192% while the median partition is at about 22%.",
    "Skew remains above 8x because the new partitions receive only non-hot-tenant traffic.",
    "The cluster write rate and partition count can both look reasonable while the hot partition fails.",
  ],
  explain:
    "Partition count sets how many key ranges exist, not how a single key is distributed. With a tenant-id key, the hot tenant is one range. The fix changes the key or the placement: a bucket suffix spreads writes for that tenant, and dedicated capacity isolates the blast radius. Both change the operational model, because reads must now gather multiple buckets or route to a known tenant shard.",
  fix: defaults({
    writesPerSecond: 8_000,
    hotTenantShare: 60,
    partitions: 12,
    partitionCapacity: 3_000,
    spreadHotTenant: 1,
  }),
  debrief:
    "With four buckets the same 4,800 writes/s split into four 1,200 writes/s streams, so the hottest partition falls to 40% of a 3,000 writes/s ceiling. Skew drops to about 3x. The tradeoff is that reads for the hot tenant must combine buckets, and the bucket count becomes part of the schema contract.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A hot partition is a key range that receives far more traffic than its peers. The cluster can have plenty of aggregate capacity and still fail, because capacity is attached to partitions and a single key range cannot use another partition's disk or write throughput.",
  },
  {
    type: "p",
    text: "Skew is a distribution problem, not an average problem. If eight partitions share 6,000 writes per second, the average is 750 writes per second each. That number says nothing about the partition carrying 4,800. Measure the maximum and the median, then compare the maximum with that partition's own ceiling.",
  },
  {
    type: "p",
    text: "A partition key decides placement. A tenant id gives every row for that tenant the same partition. Adding partitions adds key ranges, but the tenant still hashes to one range. A bucket suffix, a composite key, or a dedicated table changes the placement. Each option has a cost: reads may need to gather buckets, and the application must know the bucketing scheme.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Writes arrive at the table router, which maps the key to a partition. The partition owns its log, indexes, and storage volume. Reads follow the same map. A hot write key therefore creates a hot log, a hot index, and a hot disk. In PostgreSQL declarative partitioning, the parent table routes rows to child tables by the partition key; a tenant with one large child table concentrates vacuum, index growth, and I/O on that child.",
  },
  {
    type: "table",
    headers: ["Symptom", "What it usually means", "First check"],
    rows: [
      ["One shard at 100%, others idle", "Low-cardinality or tenant-only key", "Per-partition write rate"],
      ["Disk full on one volume", "Hot range also owns the growth", "Per-partition size and retention"],
      ["Latency rises before CPU", "Queueing at the partition's write path", "Partition write capacity and throttles"],
      ["Adding shards does not help", "The hot key still maps to one range", "Key composition and bucket count"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hottest partition: utilization of the busiest partition, warning at 80% and critical at 100% in this model.",
      "Skew: hottest partition divided by the median, warning at 3x and critical at 6x.",
      "Headroom on the hottest partition: capacity minus its current write rate. Negative means overload.",
      "Per-partition cards and a heat strip: one card turns critical while its neighbors stay calm.",
      "A key-spreading toggle: compare a tenant-id key with a bucketed key at the same total traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Hot tenant. Read the hottest partition and the median before touching a slider. Add partitions and watch the hottest value stay high. Turn on Spread hot tenant key to see the load divide. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Partition counts, capacities, and thresholds are illustrative teaching values. Real limits depend on the engine, instance class, storage, item size, and access pattern. The shape of the failure is the lesson: the busiest key range, not the cluster average, decides when the system saturates.",
  },
  { type: "sim", simId: "hot-partitions" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One tenant produced 60% of 8,000 writes per second, or 4,800 writes per second, and all of them mapped to a single partition with a 2,500 writes per second ceiling. That partition ran at 192% while the median sat near 22%. The cluster total and the partition count both looked reasonable, which is why an average-based dashboard missed the incident.",
  },
  {
    type: "p",
    text: "Changing the key to four buckets divided the tenant's writes into four 1,200 writes per second streams. The hottest partition fell to 40% of a 3,000 writes per second ceiling, and skew fell to about 3x. The load did not disappear; it moved to a distribution the partitions could absorb.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-partition write rate, throttles, and latency. A cluster-wide average hides the partition that is actually saturated.",
      "PostgreSQL: row counts and inserts per child table from pg_stat_all_tables, child table sizes, autovacuum activity, and lock waits on the hot child.",
      "DynamoDB: consumed write capacity, throttled requests, and hot-key signals per partition; the partition key design determines whether a single tenant can concentrate load.",
      "Storage: volume growth per partition, not just total database size. A hot partition can fill its own volume.",
      "Application: tenant id in slow-query logs, retry spikes from one tenant, and read fan-out after a key is bucketed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Rank partitions by write rate and compare the hottest with the median and with its own ceiling. If one key range dominates, more partitions and a bigger average instance will not fix it. Decide whether the key can be changed, whether the tenant can be isolated, and whether old rows can be archived.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the hot range: per-partition writes, disk, and latency, plus the tenant or key distribution behind it.",
      "Protect the system short term: shed or queue low-priority writes, add capacity to the hot partition if the engine allows it, and stop retry amplification.",
      "Change placement: add a bucket suffix for the hot tenant, isolate it on dedicated capacity, or split by time if the access pattern permits.",
      "Update reads for the new key: gather buckets, keep a routing map, or keep a compatibility path for old keys.",
      "Archive or delete old rows if the hot partition's growth is retention-driven, and verify that vacuum or compaction can keep up.",
      "Set alerts on per-partition skew and on the hottest partition's headroom, not only on cluster averages.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Bucketing spreads writes but makes reads fan out and adds a schema contract that every writer must follow.",
      "Dedicated capacity isolates the tenant but creates a per-tenant operational model and can waste capacity at low traffic.",
      "More partitions improve parallelism but increase metadata, connections, and the chance of an accidental hot key.",
      "Archiving reduces growth but may break queries that expect history and can move load to a different time window.",
      "A larger partition raises the ceiling without fixing skew, which buys time but hides the distribution problem.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "detect-skew",
    question: "A partitioned table has 12 partitions and the cluster looks 30% utilized, but writes time out. How do you find the hot partition?",
    difficulty: 3,
    hints: [
      "Averages hide the distribution.",
      "Look at per-partition writes, latency, and disk.",
    ],
    answer:
      "I would stop looking at the cluster average and rank partitions by write rate, latency, throttles, and disk growth. Then I would correlate the hottest range with the key distribution, for example the largest tenant id in the write logs. If one partition is at its ceiling while the median is far below, it is a skew problem, not a total-capacity problem. I would also check whether the hot partition's disk is filling, because the same key range owns the growth.",
    followUps: [
      "Which metric would you put on the dashboard?",
      "How would you confirm the tenant is the cause?",
      "What would make you choose isolation over bucketing?",
    ],
    redFlags: [
      "Adds partitions without checking the key.",
      "Uses cluster average utilization as the diagnosis.",
      "Ignores disk growth on the hot partition.",
    ],
    rubric: [
      "Ranks per-partition metrics.",
      "Correlates the hot range with a tenant or key.",
      "Separates skew from total capacity.",
      "Checks the hot partition's disk.",
    ],
  },
  {
    id: "why-more-partitions-fail",
    question: "Why can adding partitions make no difference to a single hot tenant?",
    difficulty: 2,
    hints: [
      "The key decides placement.",
      "A new range does not split an existing key.",
    ],
    answer:
      "Partitions define key ranges. A tenant id hashes or routes to one range regardless of how many other ranges exist, so the hot tenant's writes still land in the same place. Adding partitions only helps if the key has enough distinct values to spread across the new ranges. To change the outcome I need to change the key, for example by adding a bucket suffix, or place that tenant on separate capacity.",
    followUps: [
      "What happens to reads after you add buckets?",
      "How many buckets would you choose?",
      "When is isolation better than bucketing?",
    ],
    redFlags: [
      "Assumes partitions automatically rebalance a single key.",
      "Ignores read fan-out.",
      "Does not mention the key.",
    ],
    rubric: [
      "Explains key-to-partition mapping.",
      "States that new ranges do not split one key.",
      "Names a key change or isolation.",
      "Mentions the read consequence.",
    ],
  },
  {
    id: "choose-split",
    question: "You must fix a hot tenant this week. Do you bucket its key or isolate it on dedicated capacity?",
    difficulty: 3,
    hints: [
      "Bucketing changes every writer and reader.",
      "Isolation changes the operational model but not the key.",
    ],
    answer:
      "I would choose based on time and read shape. Bucketing is a schema and application change: writers add a bucket suffix and readers gather buckets, but it uses existing capacity and scales with the tenant. Isolation is faster to operate if the platform supports a dedicated partition or table: the key stays stable and the blast radius is contained, but it adds a per-tenant deployment and may waste capacity. For a one-week fix I would isolate the tenant if the platform allows it, then bucket the key as the durable fix if the tenant keeps growing.",
    followUps: [
      "What would you monitor after each option?",
      "How would you migrate existing rows?",
      "What if the tenant's reads must stay ordered?",
    ],
    redFlags: [
      "Chooses one option without discussing read impact.",
      "Ignores migration cost.",
      "Assumes isolation needs no capacity planning.",
    ],
    rubric: [
      "Compares application versus operational change.",
      "Discusses read fan-out or ordering.",
      "Names a migration path.",
      "Picks a durable fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Per-partition write rate, latency, throttles, and disk are on the dashboard.",
      "The key distribution is known: top tenants and their share of writes.",
      "A bucket or isolation path exists for the largest tenants.",
      "Retention and archival are defined for high-growth tables.",
      "Alerts compare the hottest partition with its own ceiling, not the cluster average.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Rank partitions and confirm that one range is saturated.",
      "Identify the tenant or key behind the hot range.",
      "Shed or queue low-priority writes and stop retry amplification.",
      "Add capacity or isolate the tenant while the durable key change is prepared.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Implement bucketing or isolation and migrate reads safely.",
      "Verify skew and disk growth per partition after the change.",
      "Update the key design review and load tests with tenant skew.",
      "Record the capacity ceiling and the next trigger for another split.",
    ],
  },
];

const references = [
  {
    title: "Best practices for designing and using partition keys effectively",
    url: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Partition key cardinality, hot partitions, and spreading workloads across partitions.",
  },
  {
    title: "PostgreSQL: Table Partitioning",
    url: "https://www.postgresql.org/docs/current/ddl-partitioning.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Declarative partitioning, partition pruning, and the limits of partition-wise placement.",
  },
  {
    title: "Amazon DynamoDB: Partitions and data distribution",
    url: "https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How items map to partitions and why per-partition capacity bounds throughput.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-partitions": {
      model: partitionModel,
      presets,
      instructions:
        "Start healthy, apply Hot tenant, and compare the hottest partition with the median. Add partitions, then turn on Spread hot tenant key. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Partition counts, per-partition capacity, and thresholds are teaching values, not engine limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-partitioning",
    "databases-rds-aurora-arch",
    "streaming-hot-partition",
    "foundations-capacity-headroom",
    "databases-query-plans",
  ],
};
