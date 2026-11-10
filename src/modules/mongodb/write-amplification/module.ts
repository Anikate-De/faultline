import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRIMARY_IOPS = 60_000;

const params: ParamSpec[] = [
  {
    id: "writeRate",
    label: "Logical write rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 8_000,
    unit: " writes/s",
    group: "Traffic",
    help: "Application inserts and updates per second before any write amplification. This is the useful work, not the physical I/O it causes.",
    format: "rps",
  },
  {
    id: "indexCount",
    label: "Secondary indexes",
    min: 0,
    max: 20,
    step: 1,
    value: 4,
    unit: "",
    group: "Schema",
    help: "Every index that contains a changed field must be updated on every write. More indexes speed reads and add physical writes to the write path.",
    format: "count",
  },
  {
    id: "documentGrowth",
    label: "Document growth per update",
    min: 0,
    max: 200,
    step: 5,
    value: 0,
    unit: "%",
    group: "Schema",
    help: "How much an average update grows its document. WiredTiger writes updated documents out of place, so growth creates new versions and more cache and disk work.",
    format: "percent",
  },
  {
    id: "replicaCopies",
    label: "Replica copies",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Data-bearing members that apply the write. Each secondary repeats document and index maintenance, so cluster-wide physical writes grow with copies.",
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
  indexCount: number;
  documentGrowth: number;
  replicaCopies: number;
  primaryAmp: number;
  clusterAmp: number;
  diskUtilization: number;
  writeP99: number;
  sustainableWrites: number;
  dropRate: number;
  clusterIops: number;
  replicaLag: number;
}

function compute(p: Params): Computed {
  const writeRate = clamp(num(p, "writeRate", 8_000), 0, 50_000);
  const indexCount = clamp(num(p, "indexCount", 4), 0, 30);
  const documentGrowth = clamp(num(p, "documentGrowth", 0), 0, 300);
  const replicaCopies = Math.round(clamp(num(p, "replicaCopies", 3), 1, 3));

  // Illustrative cost model: one document write, one journal append, and index maintenance.
  const primaryAmp = 2 + indexCount * 0.6 + (documentGrowth / 100) * 1.5;
  const clusterAmp = primaryAmp * replicaCopies;
  const physicalWrites = writeRate * primaryAmp;
  const diskUtilization = clamp(physicalWrites / PRIMARY_IOPS);
  const overload = physicalWrites / PRIMARY_IOPS;
  const writeP99 =
    overload >= 1
      ? Math.min(800, 200 + (overload - 1) * 120)
      : 2 + 6 * diskUtilization + (12 * diskUtilization ** 4) / Math.max(0.05, 1 - diskUtilization);
  const sustainableWrites = PRIMARY_IOPS / primaryAmp;
  const dropRate = writeRate > sustainableWrites ? (1 - sustainableWrites / writeRate) * 100 : 0;
  const clusterIops = physicalWrites * replicaCopies;
  const replicaLag = replicaCopies > 1 ? clamp(diskUtilization * 2.5, 0, 30) : 0;

  return {
    writeRate,
    indexCount,
    documentGrowth,
    replicaCopies,
    primaryAmp,
    clusterAmp,
    diskUtilization,
    writeP99,
    sustainableWrites,
    dropRate,
    clusterIops,
    replicaLag,
  };
}

function health(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const diskHealth = health(values.diskUtilization * 100, 70, 90);
  const primaryHealth = diskHealth;
  const secondaryHealth = values.replicaCopies >= 2 ? diskHealth : "down";
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application",
      kind: "client",
      health: values.dropRate >= 10 ? "crit" : values.dropRate >= 1 ? "warn" : "ok",
      sublabel: `${Math.round(values.writeRate).toLocaleString()} logical writes/s`,
      detail:
        "The application issues logical writes. It does not see how many index, journal, and replica writes each one becomes.",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: primaryHealth,
      utilization: values.diskUtilization,
      throughput: Math.min(values.writeRate, values.sustainableWrites),
      sublabel: `${values.primaryAmp.toFixed(1)}x amplification · ${values.diskUtilization.toFixed(0)}% disk`,
      detail:
        "The primary updates the document, appends to the journal, and maintains every index whose fields changed. Updates are written out of place, so document growth creates more versions.",
      meta: { view: "flow", amplification: values.primaryAmp },
    },
    {
      id: "disk",
      label: "Primary storage",
      kind: "storage",
      health: diskHealth,
      utilization: values.diskUtilization,
      sublabel: `${Math.round(values.clusterIops).toLocaleString()} physical writes/s cluster-wide`,
      detail:
        "Disk capacity is measured in physical writes, not logical writes. When this resource saturates, the primary cannot absorb more work even if CPU and network look fine.",
      meta: { view: "flow", iops: values.clusterIops },
    },
    {
      id: "secondary-a",
      label: "Secondary A",
      kind: "db",
      role: "replica",
      health: secondaryHealth,
      utilization: values.diskUtilization,
      sublabel:
        values.replicaCopies >= 2 ? `lag ${values.replicaLag.toFixed(1)}s` : "not configured",
      detail:
        "A secondary applies the same document and index changes through the oplog. Replication copies the logical operation, not the primary's physical pages.",
      meta: { view: "flow" },
    },
    {
      id: "secondary-b",
      label: "Secondary B",
      kind: "db",
      role: "replica",
      health: values.replicaCopies >= 3 ? secondaryHealth : "down",
      utilization: values.replicaCopies >= 3 ? values.diskUtilization : 0,
      sublabel:
        values.replicaCopies >= 3 ? `lag ${values.replicaLag.toFixed(1)}s` : "not configured",
      detail:
        "Each additional data-bearing member repeats index maintenance. More copies improve durability and read capacity but multiply cluster write work.",
      meta: { view: "flow" },
    },
  ];

  const edges = [
    edge("app-primary", "app", "primary", clamp(values.writeRate / 30_000)),
    edge("primary-disk", "primary", "disk", values.diskUtilization, diskHealth),
    edge(
      "primary-secondary-a",
      "primary",
      "secondary-a",
      values.replicaCopies >= 2 ? clamp(values.writeRate / 30_000) : 0,
      secondaryHealth,
    ),
    edge(
      "primary-secondary-b",
      "primary",
      "secondary-b",
      values.replicaCopies >= 3 ? clamp(values.writeRate / 30_000) : 0,
      values.replicaCopies >= 3 ? secondaryHealth : "down",
    ),
  ];

  const summary = `${Math.round(values.writeRate).toLocaleString()} logical writes/s · ${values.primaryAmp.toFixed(1)}x amplification · ${values.diskUtilization.toFixed(0)}% disk · ${values.dropRate.toFixed(0)}% dropped`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("write-amplification", "Write amplification", values.primaryAmp, "x", 6, 9, "number"),
      metric(
        "disk-utilization",
        "Disk I/O utilization",
        values.diskUtilization * 100,
        "%",
        70,
        90,
        "percent",
      ),
      metric("write-p99", "Write p99", values.writeP99, "ms", 25, 100, "ms"),
      metric(
        "sustainable-writes",
        "Sustainable writes",
        values.sustainableWrites,
        "/s",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      amplification: values.primaryAmp,
      diskUtilization: values.diskUtilization,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 4)) / 2.5);
  const rows: [string, number, number][] = [
    ["write-amplification", values.primaryAmp, 0.01],
    ["disk-utilization", values.diskUtilization * 100, 0.3],
    ["write-p99", values.writeP99, 0.2],
    ["sustainable-writes", values.sustainableWrites, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "write-amplification",
    metricId: "write-amplification",
    warn: 6,
    crit: 9,
    title: "Each logical write is becoming many physical writes",
    cause:
      "Every changed index must be updated, the journal appends the operation, and WiredTiger writes the document and index pages out of place. Document growth adds more versions. The multiplier, not the logical write rate alone, sets disk work.",
    fix: "Remove indexes that no query uses, cap document growth by designing bounded fields or pre-allocating, and batch updates where the product allows. Verify read plans before dropping an index.",
    checkFirst: [
      "Check the number of indexes on the hot collection and their write traffic.",
      "Check whether documents grow on update and how often.",
      "Check disk write IOPS and queue depth against logical write rate.",
    ],
  },
  {
    id: "disk-utilization",
    metricId: "disk-utilization",
    warn: 70,
    crit: 90,
    title: "Primary disk I/O is saturated",
    cause:
      "Physical writes have reached the storage device's modeled capacity. Queueing raises write latency nonlinearly, and the primary cannot accept more logical writes even if CPU is available.",
    fix: "Reduce amplification first, then add IOPS capacity if the workload still needs it. Moving reads and indexes off the hot path is cheaper than adding storage for index maintenance.",
    checkFirst: [
      "Check write IOPS, write latency, and queue depth on the primary's data volume.",
      "Check amplification and index count before assuming the device is too small.",
      "Check whether a background job or bulk update is adding writes.",
    ],
  },
  {
    id: "write-p99",
    metricId: "write-p99",
    warn: 25,
    crit: 100,
    title: "Write latency is rising",
    cause:
      "The primary is queueing behind physical writes. At high utilization, a small increase in writes creates a large increase in p99 latency because the disk is the shared bottleneck.",
    fix: "Lower the physical write rate before adding retries. Check index count, document growth, and batch sizes, then scale IOPS if necessary.",
    checkFirst: [
      "Check disk utilization and queue depth, not just application write rate.",
      "Check whether retries or duplicate writes are raising offered load.",
      "Check for checkpoint or journal stalls in the server log.",
    ],
  },
];

export const writeAmplificationModel: SimModel = {
  id: "mongodb-write-amplification",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.4, 0.4) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "write-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.diskUtilization >= 0.9 && !Number(next.flags.diskAnnounced ?? 0)) {
      pushEvent(next, {
        id: "disk-saturated",
        at: frame.t,
        severity: "crit",
        title: "Write amplification has saturated primary storage",
        detail: `${values.primaryAmp.toFixed(1)} physical writes per logical write at ${Math.round(values.writeRate).toLocaleString()} logical writes/s. The primary disk, not the query rate, is the limit.`,
        nodeId: "disk",
        metricId: "disk-utilization",
      });
      next.flags.diskAnnounced = 1;
    }
    if (values.primaryAmp >= 9 && !Number(next.flags.amplificationAnnounced ?? 0)) {
      pushEvent(next, {
        id: "amplification-high",
        at: frame.t,
        severity: "warn",
        title: "Index and document maintenance dominate the write path",
        detail: `${values.indexCount.toFixed(0)} indexes and ${values.documentGrowth.toFixed(0)}% document growth produce ${values.primaryAmp.toFixed(1)} physical writes per logical write.`,
        nodeId: "primary",
        metricId: "write-amplification",
      });
      next.flags.amplificationAnnounced = 1;
    }
    if (values.diskUtilization < 0.7 && !Number(next.flags.calmAnnounced ?? 0)) {
      pushEvent(next, {
        id: "disk-calm",
        at: frame.t,
        severity: "info",
        title: "Write path has headroom",
        detail:
          "Disk utilization is below the warning threshold and write latency is inside the modeled budget.",
        nodeId: "disk",
      });
      next.flags.calmAnnounced = 1;
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The modeled multiplier is ${values.primaryAmp.toFixed(1)} physical writes per logical write: one document update, one journal append, ${values.indexCount.toFixed(0)} index updates, and document growth.`,
    );
    items.push(
      `${Math.round(values.writeRate).toLocaleString()} logical writes/s become about ${Math.round(values.writeRate * values.primaryAmp).toLocaleString()} physical writes/s on the primary. This is illustrative, not a WiredTiger benchmark.`,
    );
    if (values.replicaCopies > 1) {
      items.push(
        `With ${values.replicaCopies.toFixed(0)} data-bearing copies, the cluster repeats document and index maintenance on each secondary, about ${Math.round(values.clusterIops).toLocaleString()} physical writes/s cluster-wide.`,
      );
    }
    if (values.dropRate > 0) {
      items.push(
        `${values.dropRate.toFixed(0)}% of offered writes cannot be sustained at this amplification. Adding retries raises offered load and makes the gap wider.`,
      );
    }
    if (values.indexCount >= 10) {
      items.push(
        "Ten or more indexes multiply maintenance on every write. Before dropping one, check which queries depend on it; an unused index is pure write cost.",
      );
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
    description:
      "8,000 logical writes/s with four indexes and no document growth. The primary has disk headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "8,000 writes/s with seven indexes and 10% document growth. Disk is near the warning line.",
    tone: "warn",
    params: defaults({ writeRate: 8_000, indexCount: 7, documentGrowth: 10, replicaCopies: 3 }),
  },
  {
    id: "failure",
    label: "Index-heavy write burst",
    description:
      "22,000 writes/s with fourteen indexes and 80% document growth. Amplification saturates primary storage.",
    tone: "crit",
    params: defaults({ writeRate: 22_000, indexCount: 14, documentGrowth: 80, replicaCopies: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "6,000 writes/s with four indexes and no growth. Physical writes are back inside disk capacity.",
    tone: "ok",
    params: defaults({ writeRate: 6_000, indexCount: 4, documentGrowth: 0, replicaCopies: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-index-cost",
  title: "Why did adding indexes reduce write throughput?",
  simId: "write-amplification",
  question:
    "Reads are slow, so you add six secondary indexes to a hot collection. Write throughput falls and disk I/O saturates. What happened?",
  prediction: {
    options: [
      {
        id: "shard-key",
        label: "The new indexes changed the shard key and redirected writes to one shard",
      },
      {
        id: "maintenance",
        label:
          "Every insert now maintains each new index, multiplying physical writes per logical write",
      },
      {
        id: "journal",
        label: "MongoDB disabled journaling because the index count exceeded a limit",
      },
      {
        id: "network",
        label: "Replication copies increased, so the primary spent its capacity on network sends",
      },
    ],
    correctOptionId: "maintenance",
    explanation:
      "An index is another data structure that must be updated whenever a changed field appears in it. Adding indexes improves read plans but adds index maintenance to every write. Once disk I/O saturates, the primary queues writes and throughput falls. The indexes are not free; the cost moved from reads to writes.",
  },
  setup: defaults({ writeRate: 18_000, indexCount: 12, documentGrowth: 30, replicaCopies: 3 }),
  runFor: 12,
  observe: [
    "Write amplification rises above 9x and disk utilization crosses 90%.",
    "Write p99 climbs while the logical write rate stays flat or falls.",
    "The primary disk is the bottleneck; CPU and network are not the first limit.",
    "Removing indexes and bounding document growth lowers physical writes per logical write.",
  ],
  explain:
    "Write amplification is the ratio of physical writes to useful logical writes. The journal, document updates, index maintenance, and replication all contribute. Indexes are a read optimization paid for on every write. Capacity planning that counts only application writes will overestimate how much disk the workload needs.",
  fix: defaults({ writeRate: 8_000, indexCount: 5, documentGrowth: 0, replicaCopies: 3 }),
  debrief:
    "Check write IOPS, write latency, index count, and document growth together. Drop indexes no query uses, redesign unbounded growth, and batch small updates. Add IOPS only after the multiplier is under control, because more capacity at 10x amplification is an expensive way to store the same logical write.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Write amplification is the ratio between the physical work a database performs and the logical write the application requested. One insert can update the document, append to the journal, maintain several secondary indexes, and be replayed on every replica. The application sees one write; the storage device sees many.",
  },
  {
    type: "p",
    text: "WiredTiger writes updated documents and index pages out of place rather than overwriting them. The journal records operations for crash recovery, and checkpoints persist a consistent view. Document growth creates new versions instead of extending a record in place. Each of these is normal; the problem is when their sum exceeds the disk's ability to keep up.",
  },
  {
    type: "p",
    text: "Indexes are the most common multiplier teams forget. An index is a read optimization, but every write that changes an indexed field must update that index. Ten indexes on a hot collection can turn a modest insert rate into saturated disk I/O long before CPU is busy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The primary performs the document and index writes and appends to the journal. Each secondary applies the same logical operation and repeats index maintenance. The cluster's physical write cost therefore scales with both amplification per node and the number of data-bearing copies.",
  },
  {
    type: "table",
    headers: ["Write-path component", "What it adds", "How to reduce it"],
    rows: [
      [
        "Document update",
        "A new version of the document",
        "Smaller updates, bounded document growth",
      ],
      [
        "Journal append",
        "A durable record for crash recovery",
        "Fewer, larger batches; do not disable durability casually",
      ],
      [
        "Secondary index",
        "One update per affected index",
        "Drop unused indexes; design targeted ones",
      ],
      [
        "Replication",
        "The same logical work on each secondary",
        "Fewer copies only if durability allows it",
      ],
    ],
  },
  {
    type: "compare",
    leftTitle: "Read-optimized schema",
    rightTitle: "Write-optimized schema",
    rows: [
      {
        label: "Indexes",
        left: "Many indexes for query shapes",
        right: "Few indexes, more collection scans or design changes",
      },
      {
        label: "Document growth",
        left: "Flexible embedded arrays",
        right: "Bounded fields and pre-allocated space",
      },
      {
        label: "Write cost",
        left: "High per logical write",
        right: "Lower per write, possibly higher read cost",
      },
      {
        label: "Failure signal",
        left: "Disk I/O saturation at peak writes",
        right: "Read latency or scan cost rises",
      },
    ],
  },
  {
    type: "p",
    text: "The right balance depends on the product. A read-heavy catalog may justify many indexes. A write-heavy event stream may need almost none. What matters is measuring both sides: index usage from the query planner, and physical write cost from disk metrics.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Write amplification: physical writes per logical write on the primary.",
      "Disk I/O utilization: how close the primary volume is to its modeled capacity.",
      "Write p99: the latency cost of queueing behind physical writes.",
      "Sustainable writes: the logical rate the current multiplier can support.",
      "Replica copies: how the same logical write is repeated across the cluster.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Index-heavy write burst and watch disk utilization cross critical before CPU does. Reduce indexes alone, then document growth alone, to see which contributes more. Use the experiment to predict why the new indexes hurt writes.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Illustrative multipliers",
    body: "The coefficients in this model are teaching values, not a WiredTiger benchmark. Real amplification depends on document size, update patterns, compression, checkpoints, and hardware. The durable lesson is that physical writes, not application writes, set write capacity.",
  },
  { type: "sim", simId: "write-amplification" },
  { type: "experiment", experimentId: "predict-index-cost" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Each logical write was multiplied by document updates, the journal, index maintenance, and replication. The primary disk reached its modeled capacity, write latency rose, and the sustainable logical write rate fell below the offered rate. The application saw slow and dropped writes even though its own request rate had not changed.",
  },
  {
    type: "p",
    text: "Reducing the index count and bounding document growth lowered the multiplier. The same application write rate then fit inside disk capacity. Capacity had not changed; the amount of physical work per write had.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Disk write IOPS and utilization near saturation while CPU has headroom.",
      "Write latency and queue depth rising faster than the logical write rate.",
      "A collection with many indexes and a high insert or update rate.",
      "Aggregation or bulk jobs that grow documents and create new versions.",
      "Retries increasing offered writes while useful throughput falls.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the write multiplier: index count on the hot collection, document growth, journal behavior, and replica count. Then check disk write IOPS and latency. Do not add IOPS or shards before confirming that the workload is not paying for indexes no query uses.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the indexes on the hot collection and confirm which queries use them.",
      "Drop unused indexes and consolidate overlapping ones.",
      "Bound document growth or change the update pattern so documents do not expand indefinitely.",
      "Batch small writes where the product allows it.",
      "Check replication and durability requirements before reducing copies.",
      "Add IOPS capacity only after the write multiplier is understood.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping an index reduces write cost but can turn a fast read into a collection scan.",
      "Batching writes lowers overhead per operation but increases latency for each batch.",
      "Fewer replica copies reduce cluster write work but weaken durability and read capacity.",
      "Compression saves space and can add CPU cost; it does not remove index maintenance.",
      "Journaling is part of durability; disabling it to improve write throughput trades crash safety for speed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-amp",
    question: "What is write amplification in MongoDB, and why does an index increase it?",
    difficulty: 3,
    hints: [
      "Separate logical writes from physical work.",
      "An index is another structure to update.",
      "Journaling and replication add more copies.",
    ],
    answer:
      "Write amplification is physical writes divided by logical writes. One insert updates the document, appends to the journal, and updates every index whose fields changed; secondaries repeat the document and index work. An index speeds reads but must be maintained on every relevant write, so adding one increases physical writes per logical write. WiredTiger's out-of-place updates and document growth add further work.",
    followUps: [
      "How does document growth affect it?",
      "Does replication multiply primary disk I/O?",
      "How would you measure the multiplier?",
    ],
    redFlags: [
      "Says indexes only affect reads.",
      "Counts application writes as disk writes.",
      "Ignores journaling.",
    ],
    rubric: [
      "Defines physical versus logical.",
      "Names index maintenance.",
      "Mentions journal and replication.",
      "Connects to capacity.",
    ],
  },
  {
    id: "diagnose",
    question:
      "Write throughput drops and disk I/O is at 100%. What do you check before adding storage?",
    difficulty: 3,
    hints: [
      "Find the multiplier first.",
      "Look at the hot collection's indexes.",
      "Check document growth and batch jobs.",
    ],
    answer:
      "I check the hot collection's index count and which indexes the workload actually uses, then document growth and update patterns. I look for bulk jobs or retries adding physical writes, and I compare write IOPS with logical write rate to estimate amplification. If an unused index or unbounded document growth explains the multiplier, I fix that before buying more IOPS.",
    followUps: [
      "How do you know an index is unused?",
      "What does WiredTiger do on an out-of-place update?",
      "When is adding IOPS the right answer?",
    ],
    redFlags: [
      "Adds storage without checking indexes.",
      "Assumes CPU is the bottleneck.",
      "Ignores retries and bulk jobs.",
    ],
    rubric: [
      "Checks index usage.",
      "Checks document growth.",
      "Estimates amplification.",
      "Defers capacity until the multiplier is understood.",
    ],
  },
  {
    id: "tradeoff",
    question:
      "A product needs both fast reads and high write throughput. How do you decide how many indexes to keep?",
    difficulty: 3,
    hints: [
      "Measure query shapes and index usage.",
      "Not every read needs an index.",
      "Consider a different collection or model for write-heavy data.",
    ],
    answer:
      "I measure which query shapes matter and which indexes the planner uses, then remove indexes that no important query needs. I consolidate overlapping compound indexes and consider moving write-heavy event data to a separate collection or model with fewer indexes. The decision is a product tradeoff: a read optimization is worth its write cost only if the read is important enough.",
    followUps: [
      "How would you test a drop safely?",
      "What is a covered query worth here?",
      "When would you use a separate collection?",
    ],
    redFlags: [
      "Keeps every index because reads might need it.",
      "Drops indexes without checking query plans.",
      "Ignores write rate in the decision.",
    ],
    rubric: [
      "Uses query and index evidence.",
      "Consolidates indexes.",
      "Considers workload separation.",
      "States the tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show write IOPS, write latency, index count, and document growth for hot collections.",
      "Indexes are reviewed against query plans and unused indexes are removed.",
      "Bulk updates and document growth are bounded or scheduled off peak.",
      "Capacity is planned from physical writes, not application write rate alone.",
      "Replica count and durability are explicit product decisions.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check disk write utilization and queue depth before CPU.",
      "Identify the hot collection and its index maintenance cost.",
      "Check for retries, bulk jobs, or document growth raising physical writes.",
      "Do not add shards to fix a single-node disk bottleneck without checking the multiplier.",
      "Keep reads served from secondaries if they have headroom.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm write amplification and disk utilization are back inside budget.",
      "Review whether any index can be dropped or consolidated.",
      "Document the sustainable logical write rate at the current multiplier.",
      "Load-test the next peak with realistic index counts and document growth.",
    ],
  },
];

const references = [
  {
    title: "WiredTiger Storage Engine",
    url: "https://www.mongodb.com/docs/manual/core/wiredtiger/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "WiredTiger journaling, checkpoints, compression, and cache behavior.",
  },
  {
    title: "Indexes",
    url: "https://www.mongodb.com/docs/manual/core/indexes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Index types and the read and write tradeoffs of maintaining secondary indexes.",
  },
  {
    title: "Replication",
    url: "https://www.mongodb.com/docs/manual/replication/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "How secondaries apply the oplog and repeat write work.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "write-amplification": {
      model: writeAmplificationModel,
      presets,
      instructions:
        "Start Healthy, then apply Index-heavy write burst. Reduce index count and document growth separately to see which drives disk saturation. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Amplification coefficients, IOPS capacity, and latency are teaching values; real WiredTiger behavior depends on document and index layout, compression, and hardware.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-index-design", "mongodb-replication-lag", "mongodb-write-concern"],
};
