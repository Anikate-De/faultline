import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITER_CAPACITY = 1_200;
const REPLICA_CAPACITY = 900;
const READ_COST = 0.45;
const WRITE_COST = 1;

const params = [
  {
    id: "readRps",
    label: "Read traffic",
    min: 100,
    max: 8_000,
    step: 100,
    value: 1_800,
    unit: " reads/s",
    group: "Traffic",
    help: "Read requests per second. Where they connect decides whether the writer or the Aurora Replicas serve them.",
    format: "rps" as const,
  },
  {
    id: "writeRps",
    label: "Write traffic",
    min: 50,
    max: 3_000,
    step: 50,
    value: 250,
    unit: " writes/s",
    group: "Traffic",
    help: "Committed writes per second. Writes always go to the primary instance, whatever endpoint the client uses.",
    format: "rps" as const,
  },
  {
    id: "readRouting",
    label: "Reads sent to reader endpoint",
    min: 0,
    max: 100,
    step: 1,
    value: 95,
    unit: "%",
    group: "Routing",
    help: "Share of read connections that use the reader endpoint. The rest connect to the writer endpoint and compete with writes.",
    format: "percent" as const,
  },
  {
    id: "replicaCount",
    label: "Aurora Replicas",
    min: 1,
    max: 15,
    step: 1,
    value: 3,
    unit: " replicas",
    group: "Topology",
    help: "Reader instances in the cluster. They share the cluster volume, so adding one does not copy the data.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  readRps: number;
  writeRps: number;
  routing: number;
  replicas: number;
  writerReads: number;
  routedReads: number;
  writerUtil: number;
  replicaUtil: number;
  writerLatency: number;
  replicaLatency: number;
  readLatency: number;
  writerHealth: Health;
  replicaHealth: Health;
  readHealth: Health;
}

function queueLatency(utilPct: number, baseMs: number): number {
  const u = Math.max(0, utilPct) / 100;
  if (u >= 0.995) return 2_500;
  return baseMs + (8 * u) / Math.max(0.005, 1 - u);
}

function compute(p: Params): Computed {
  const readRps = Math.max(0, num(p, "readRps", 1_800));
  const writeRps = Math.max(0, num(p, "writeRps", 250));
  const routing = clamp(num(p, "readRouting", 95), 0, 100);
  const replicas = Math.max(1, Math.round(num(p, "replicaCount", 3)));
  const writerReads = readRps * (1 - routing / 100);
  const routedReads = readRps - writerReads;
  const writerDemand = writeRps * WRITE_COST + writerReads * READ_COST;
  const replicaDemand = routedReads * READ_COST;
  const writerUtil = Math.min(200, (writerDemand / WRITER_CAPACITY) * 100);
  const replicaUtil = Math.min(200, (replicaDemand / replicas / REPLICA_CAPACITY) * 100);
  const writerLatency = queueLatency(writerUtil, 3);
  const replicaLatency = queueLatency(replicaUtil, 4) + 1.2;
  const readLatency =
    readRps > 0 ? (writerReads * writerLatency + routedReads * replicaLatency) / readRps : 0;
  const writerHealth: Health = writerUtil >= 90 ? "crit" : writerUtil >= 70 ? "warn" : "ok";
  const replicaHealth: Health = replicaUtil >= 90 ? "crit" : replicaUtil >= 75 ? "warn" : "ok";
  const readHealth: Health = readLatency >= 150 ? "crit" : readLatency >= 25 ? "warn" : "ok";
  return {
    readRps,
    writeRps,
    routing,
    replicas,
    writerReads,
    routedReads,
    writerUtil,
    replicaUtil,
    writerLatency,
    replicaLatency,
    readLatency,
    writerHealth,
    replicaHealth,
    readHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.6);
  const rows: [string, number, number][] = [
    ["writer-utilization", values.writerUtil, 0.6],
    ["reader-utilization", values.replicaUtil, 0.5],
    ["read-latency", values.readLatency, 0.3],
    ["reads-on-writer", values.writerReads, 3],
    ["replica-count", values.replicas, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const totalOps = Math.max(1, values.readRps + values.writeRps);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: values.readHealth,
        sublabel: `${formatCount(values.readRps)} reads/s · ${formatCount(values.writeRps)} writes/s`,
        detail: `Read latency p99 is ${values.readLatency.toFixed(0)}ms. The connection string, not the query, decides which instance serves each read.`,
        meta: { view: "flow" },
      },
      {
        id: "writer",
        label: "Writer · cluster endpoint",
        kind: "db",
        role: "primary",
        health: values.writerHealth,
        utilization: clamp(values.writerUtil / 100),
        sublabel: `${Math.round(values.writerUtil)}% utilized · ${formatCount(values.writerReads)} read/s`,
        detail: `The writer serves every write and any read that connects through the cluster endpoint. Reads on the writer consume CPU, memory, and connection slots, and locking reads add lock waits.`,
        meta: { view: "flow", reads: values.writerReads },
      },
      {
        id: "reader",
        label: "Reader endpoint",
        kind: "lb",
        health: values.replicaHealth,
        utilization: clamp(values.replicaUtil / 100),
        sublabel: `${values.routing}% of reads routed · connection balancing`,
        detail: `The reader endpoint balances new connections across ${values.replicas} Aurora Replicas. It does not balance individual queries, and it does not include the writer while replicas exist.`,
        meta: { view: "flow", replicas: values.replicas },
      },
      {
        id: "replicas",
        label: `${values.replicas} Aurora Replicas`,
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: clamp(values.replicaUtil / 100),
        sublabel: `${Math.round(values.replicaUtil)}% utilized · shared volume`,
        detail: "Aurora Replicas read the same cluster volume as the writer. They do not hold a second copy of the data, and they can serve read-only queries.",
        meta: { view: "flow", replicas: values.replicas },
      },
    ],
    edges: [
      edge(
        "app-writer",
        "app",
        "writer",
        clamp((values.writeRps + values.writerReads) / totalOps),
        values.writerHealth,
        "read/write",
      ),
      edge(
        "app-reader",
        "app",
        "reader",
        clamp(values.routedReads / totalOps),
        values.replicaHealth,
        "read-only",
      ),
      edge(
        "reader-replicas",
        "reader",
        "replicas",
        clamp(values.routedReads / Math.max(1, values.readRps)),
        values.replicaHealth,
        "connections",
      ),
    ],
    metrics: [
      metric("writer-utilization", "Writer utilization", values.writerUtil, "%", 70, 90, "percent"),
      metric("read-latency", "Read p99", values.readLatency, "ms", 25, 150, "ms"),
      metric("reads-on-writer", "Reads on writer", values.writerReads, " reads/s", undefined, undefined, "rps"),
      metric("reader-utilization", "Reader utilization", values.replicaUtil, "%", 75, 90, "percent"),
      metric("replica-count", "Aurora Replicas", values.replicas, " replicas", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.readRps)} reads/s, ${values.routing}% through the reader endpoint; writer ${Math.round(
      values.writerUtil,
    )}%, readers ${Math.round(values.replicaUtil)}%, read p99 ${values.readLatency.toFixed(0)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "writer-utilization",
    metricId: "writer-utilization",
    warn: 70,
    crit: 90,
    title: "Reads are competing with writes on the writer",
    cause:
      "Read connections that use the cluster endpoint consume the writer's CPU, memory, and connection slots. Locking reads add lock waits, and long reads hold snapshots that delay cleanup. The writer was sized for writes, so read volume becomes the bottleneck.",
    fix:
      "Send read-only connections to the reader endpoint or a custom endpoint, reconnect existing pools, and keep the writer endpoint for writes and read-after-write paths. Add Aurora Replicas if the reader fleet is also saturated.",
    checkFirst: [
      "Check which endpoint the read-only connection string uses.",
      "Check whether the read query takes locks or runs a long transaction on the writer.",
      "Compare writer CPU and DatabaseConnections with reader utilization.",
    ],
  },
  {
    id: "read-latency",
    metricId: "read-latency",
    warn: 25,
    crit: 150,
    title: "Read latency is dominated by the writer",
    cause:
      "The writer is above the queueing knee. Each read waits behind other reads and writes, so latency rises faster than the load and the database may still report healthy query execution for the writes it does finish.",
    fix:
      "Move read-only traffic off the writer, reduce the read rate, or add reader capacity. Increasing the writer size can absorb the load, but it leaves read and write contention in place.",
    checkFirst: [
      "Compare read p99 with writer and reader utilization.",
      "Check whether all replicas are healthy and reachable through the reader endpoint.",
      "Check whether a pool is pinned to one instance endpoint.",
    ],
  },
  {
    id: "reader-utilization",
    metricId: "reader-utilization",
    warn: 75,
    crit: 90,
    title: "The reader fleet is saturated",
    cause:
      "Routed reads exceed the capacity of the Aurora Replicas. The reader endpoint balances connections across replicas, so every replica must have headroom, not just the fleet average.",
    fix:
      "Add Aurora Replicas, reduce read volume, or split workloads across custom endpoints. Check for a single long-running reporting query that dominates one replica.",
    checkFirst: [
      "Check utilization per replica, not only the cluster total.",
      "Check whether one connection or query dominates a replica.",
      "Check whether the reader endpoint is reaching every replica.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const topologyModel: SimModel = {
  id: "databases-rds-aurora-arch",
  visual: "topology",
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
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.writerUtil >= 90 && frame.flags.writerSaturated !== 1) {
      pushEvent(next, {
        id: "reads-on-writer",
        at: frame.t,
        severity: "crit",
        title: "Read traffic is saturating the writer",
        detail: `${formatCount(values.writerReads)} reads/s still use the writer endpoint. Writer utilization is ${Math.round(
          values.writerUtil,
        )}% while the reader fleet is ${Math.round(values.replicaUtil)}% utilized.`,
        nodeId: "writer",
        metricId: "writer-utilization",
      });
    }
    next.flags.writerSaturated = values.writerUtil >= 90 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `${formatCount(values.readRps)} reads/s with ${values.routing}% on the reader endpoint leaves ${formatCount(
        values.writerReads,
      )} reads/s on the writer and ${formatCount(values.routedReads)} reads/s on ${values.replicas} replicas.`,
    ];
    if (values.writerUtil >= 90) {
      items.push(
        `The writer is at ${Math.round(values.writerUtil)}%, so read p99 is ${Math.round(
          values.readLatency,
        )}ms while the reader fleet is only ${Math.round(values.replicaUtil)}% utilized.`,
      );
    } else {
      items.push(
        `Writer utilization is ${Math.round(values.writerUtil)}% and reader utilization is ${Math.round(
          values.replicaUtil,
        )}%; read p99 is ${values.readLatency.toFixed(0)}ms.`,
      );
    }
    items.push(
      "Aurora Replicas share the cluster volume, so adding one adds read compute but not a second copy of the data. RDS read replicas are separate instances with their own storage and asynchronous replication.",
    );
    items.push(
      "The reader endpoint balances connections, not statements. A long-lived pool keeps each connection on the replica it first reached, so verify that the pool reconnects after a topology change.",
    );
    items.push(
      "Use the instance endpoint only for diagnosis or a pinned workload. It bypasses endpoint failover behavior and can strand traffic on one instance.",
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
    description: "Most reads use the reader endpoint; the writer serves writes with headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak reads",
    description: "Read traffic grows with the same routing; the reader fleet reaches its warning band.",
    tone: "warn",
    params: defaults({ readRps: 5_200, readRouting: 90, replicaCount: 3 }),
  },
  {
    id: "failure",
    label: "Reads on the writer",
    description: "Reads still use the cluster endpoint while the reader fleet sits nearly idle.",
    tone: "crit",
    params: defaults({ readRps: 2_400, writeRps: 350, readRouting: 5, replicaCount: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Read-only connections use the reader endpoint and the writer returns to write-sized load.",
    tone: "ok",
    params: defaults({ readRps: 2_400, writeRps: 350, readRouting: 95, replicaCount: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-endpoint",
  title: "Move the reads without adding capacity",
  simId: "rds-aurora-arch",
  question:
    "A reporting workload sends 2,400 reads per second to the cluster endpoint. The writer is above 100% and read p99 is seconds, while the reader fleet is nearly idle. Which change removes the queue with the least new capacity?",
  prediction: {
    options: [
      { id: "enlarge", label: "Enlarge the writer instance." },
      { id: "reader", label: "Point read-only connections at the reader endpoint and reconnect." },
      { id: "add-replica", label: "Add a replica without changing the connection string." },
      { id: "max-conn", label: "Raise max_connections on the writer." },
    ],
    correctOptionId: "reader",
    explanation:
      "The reads are connecting to the cluster endpoint, which always resolves to the writer. The reader endpoint balances new connections across the Aurora Replicas. Existing pooled connections stay where they connected, so the application must reconnect through the reader endpoint. Adding a replica without moving the connection string leaves the traffic on the writer, and raising max_connections adds slots, not CPU.",
  },
  setup: defaults({ readRps: 2_400, writeRps: 350, readRouting: 5, replicaCount: 2 }),
  runFor: 20,
  observe: [
    "Writer utilization is above 100% and read p99 is capped by the queueing model.",
    "About 2,280 reads per second still arrive at the writer.",
    "The two Aurora Replicas are below 5% utilization.",
    "Read latency follows the writer, not the reader fleet.",
  ],
  explain:
    "The endpoint is part of the routing decision. The cluster endpoint follows the writer for reads and writes; the reader endpoint accepts read-only connections and balances them across replicas. No amount of replica capacity helps until the client connects to the endpoint that reaches it.",
  fix: defaults({ readRps: 2_400, writeRps: 350, readRouting: 95, replicaCount: 3 }),
  debrief:
    "With 95% of reads on the reader endpoint, the writer returns to about 34% and the three replicas share the read load at 38% each. The writer still serves every write and the small read-after-write path that needs it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Relational Database Service (RDS) is a managed database instance. Aurora is a managed database cluster with a distributed storage volume and one or more database instances attached to it. Both speak the same database protocols, but they separate compute from storage differently, and that difference decides what a replica is and which endpoint reaches it.",
  },
  {
    type: "p",
    text: "An RDS DB instance owns its storage. A Multi-AZ DB instance deployment keeps a synchronous standby in another Availability Zone, but that standby does not serve reads and there is no reader endpoint for it; read scaling uses read replicas. A Multi-AZ DB cluster deployment is different: its reader instances can serve read traffic, but it is still a cluster deployment with its own endpoints, not a single standby. An RDS read replica is a separate instance with its own storage, updated asynchronously from the primary, and it has its own endpoint. An Aurora cluster is different: the cluster volume spans three Availability Zones, and every Aurora Replica reads that same volume. Adding an Aurora Replica adds compute; it does not copy the table data.",
  },
  {
    type: "p",
    text: "Endpoints are how clients reach the right instance. The cluster endpoint or writer endpoint always points to the primary instance. The reader endpoint accepts read-only connections and balances them across Aurora Replicas. An instance endpoint pins one specific instance. A custom endpoint groups a subset of instances. The reader endpoint balances connections, not individual queries, and it excludes the writer while replicas exist; when the cluster has only a primary, it connects to the primary.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A request travels from the application connection pool to an endpoint, then to a database instance, then to storage. The endpoint is a name, not a proxy that inspects every statement. A pooled connection is resolved once and stays on that instance until it is closed or the instance fails. This is why moving read traffic is a connection-string and pool-reconnect change, not just a query change.",
  },
  {
    type: "table",
    headers: ["Endpoint", "Reaches", "Use it for"],
    rows: [
      ["Writer or cluster endpoint", "The primary instance", "Writes, DDL, and reads that must be current"],
      ["Reader endpoint", "Aurora Replicas, by connection", "Read-only queries that tolerate replica freshness"],
      ["Instance endpoint", "One named instance", "Diagnosis or a deliberately pinned workload"],
      ["Custom endpoint", "A chosen subset of instances", "Separating reporting from application reads"],
    ],
  },
  {
    type: "compare",
    leftTitle: "RDS",
    rightTitle: "Aurora",
    rows: [
      { label: "Storage", left: "Per-instance block storage", right: "Shared cluster volume across three AZs" },
      { label: "Read replica", left: "Separate instance with its own storage", right: "Instance on the shared volume" },
      { label: "Replica data copy", left: "Asynchronous engine replication", right: "No table copy when adding a replica" },
      { label: "Reader endpoint", left: "No built-in reader endpoint", right: "Reader endpoint balances connections" },
    ],
  },
  {
    type: "p",
    text: "The writer is sized for writes in this model. Read queries that reach it still consume its CPU, memory, and connection slots, and locking reads take row or table locks. A plain long SELECT does not block an INSERT, but it holds a snapshot that can delay vacuum and it competes for the same resources. Treat reads on the writer as a routing problem first and a sizing problem second.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Writer utilization: read-equivalent work on the primary. Warning at 70%, critical at 90%.",
      "Read p99: queueing delay weighted by where reads connect, warning at 25ms and critical at 150ms.",
      "Reads on writer: the volume still using the writer endpoint.",
      "Reader utilization: routed reads divided across Aurora Replicas.",
      "Replica count: adding replicas adds read capacity but does not change the endpoint a client already uses.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Reads on the writer and compare the writer and reader utilization before reading the explanation. Then move the read-routing slider back to 95% and watch the writer recover without a larger instance. Run the experiment, reveal the answer, then apply Recovery.",
  },
  {
    type: "p",
    text: "Capacities, latencies, and thresholds are illustrative teaching values, not RDS or Aurora limits. Aurora currently supports up to 15 Aurora Replicas per cluster; an Aurora Global Database supports up to 10 secondary DB clusters. The simulation uses 1–15 replicas to keep the routing tradeoff visible.",
  },
  { type: "sim", simId: "rds-aurora-arch" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The reads used the cluster endpoint, which resolves to the writer. The writer had already been sized for the write rate, so the read load pushed it past the queueing knee. The reader fleet stayed nearly idle because no connection reached it. Read latency rose with writer utilization, and the database looked like it needed a bigger instance even though the capacity was already in the cluster.",
  },
  {
    type: "p",
    text: "Changing the connection string to the reader endpoint moved the read-only connections. Existing pooled connections had to reconnect before the change took effect. The writer returned to write-sized load, and the replicas shared the read work. Adding a replica alone would not have moved a single connection that was still addressed to the writer.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Aurora: DatabaseConnections, CPUUtilization, and read latency per instance; AuroraReplicaLag in milliseconds for each replica.",
      "RDS: ReplicaLag for read replicas, plus the replica's own endpoint. A Multi-AZ standby is not readable and does not appear as a replica target.",
      "PostgreSQL: pg_stat_activity grouped by client address and application_name to see which pool is on which instance; pg_locks and wait events for contention.",
      "Connection pools: the host each pool resolved, its open connections, and whether it reconnects after a failover.",
      "Query logs: report queries and long read transactions on the writer, especially SELECT ... FOR UPDATE and repeatable-read transactions.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the connection string and the pool's current host before resizing anything. If read-only traffic uses the writer endpoint, fix routing first. Then check whether the read takes locks or merely consumes resources. The endpoint is the cheapest lever; the instance size is the expensive one.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the read-only workloads and their consistency needs. Reporting and background jobs usually tolerate a small replica delay; read-after-write paths do not.",
      "Point read-only pools at the reader endpoint or a custom endpoint, and recycle the pools so connections actually move.",
      "Keep writes and read-after-write traffic on the writer endpoint. Do not split them by query text at the last second.",
      "Add Aurora Replicas or custom endpoint groups when the reader fleet, not the writer, is the constraint.",
      "Check per-instance utilization and lag after the move; the reader endpoint can still concentrate connections on one replica.",
      "Resize the writer only after routing is correct and the remaining write load needs it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Reader endpoints offload the writer but serve data that can be slightly behind. That is acceptable for reporting and usually not for a read-after-write screen.",
      "More replicas add read capacity and cost, but the cluster still has one writer. They do not make writes faster.",
      "Instance endpoints are precise and bypass endpoint failover behavior. Pinning a pool to one instance can strand it when that instance is replaced.",
      "A larger writer absorbs both reads and writes, but it concentrates contention and cost on one instance.",
      "Aurora Replicas share storage, so a storage-level problem affects every instance. Replicas improve compute availability, not storage isolation.",
      "RDS read replicas are separate instances with their own storage and asynchronous replication; they can be promoted, but they are not a synchronous standby.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "draw-topology",
    question: "Draw an Aurora cluster and explain what happens to a read sent to the reader endpoint.",
    difficulty: 2,
    hints: [
      "Separate the endpoint, the instances, and the storage volume.",
      "The endpoint balances connections, not statements.",
    ],
    answer:
      "I would draw one writer instance and up to 15 Aurora Replicas attached to a shared cluster volume that spans three Availability Zones. The reader endpoint accepts read-only connections and balances each new connection across the available Aurora Replicas. It does not inspect or route individual queries, so a long-lived pooled connection stays on the replica it first reached. The replicas read the same volume as the writer, so adding one adds compute without copying the data. The writer endpoint always points to the primary and is used for writes and for reads that must be current.",
    followUps: [
      "What happens to the reader endpoint when the cluster has no replicas?",
      "How does a connection pool change the balancing?",
      "What does an instance endpoint do differently?",
    ],
    redFlags: [
      "Says the reader endpoint balances queries.",
      "Says Aurora replicas each hold a full copy of the data.",
      "Confuses the reader endpoint with a load balancer that inspects SQL.",
    ],
    rubric: [
      "Separates writer, replicas, and shared storage.",
      "States connection-level balancing.",
      "Names the writer endpoint for writes.",
      "Mentions pool pinning.",
    ],
  },
  {
    id: "multi-az-vs-replica",
    question: "What is the difference between an RDS Multi-AZ standby and an RDS read replica?",
    difficulty: 2,
    hints: [
      "One is for failover; the other is for read scaling.",
      "One is synchronous and one is asynchronous.",
    ],
    answer:
      "A Multi-AZ DB instance deployment keeps a synchronous standby in another Availability Zone for failover. The standby is not readable and does not appear as a replica target. A read replica is a separate instance with its own storage, updated asynchronously from the primary, and it has its own endpoint. Read replicas can serve read traffic and can be promoted, but they can lag. A Multi-AZ DB cluster is a third shape: it has readable instances and failover support, but it is still a different deployment model from a single read replica.",
    followUps: [
      "Which one can serve reporting queries?",
      "Which one has a non-zero replication lag?",
      "When would you choose a Multi-AZ DB cluster instead?",
    ],
    redFlags: [
      "Says the standby serves reads.",
      "Says read replicas are synchronous.",
      "Treats promotion and failover as the same operation.",
    ],
    rubric: [
      "States synchronous standby.",
      "States asynchronous read replica.",
      "Notes the standby is not readable.",
      "Notes the replica has its own endpoint.",
    ],
  },
  {
    id: "read-locks",
    question:
      "A read query is hitting the writer and piling up locks. Which endpoint and topology should it use, and what would you check first?",
    difficulty: 3,
    hints: [
      "Not every read lock is a routing problem.",
      "The endpoint decides the instance; the query decides the lock.",
    ],
    answer:
      "First I would confirm what the read is doing. A plain SELECT does not block writes, but SELECT ... FOR UPDATE, advisory locks, and long repeatable-read transactions do take locks or hold snapshots. If the query is read-only, I would move it to the reader endpoint or a custom endpoint for its workload, and recycle the pool so it leaves the writer. If it needs to read its own recent writes, I would keep that path on the writer or use a consistency mechanism. I would check pg_locks, wait events, and pg_stat_activity on the writer, plus per-replica utilization and lag, before changing the topology.",
    followUps: [
      "What if the report needs a consistent snapshot across several tables?",
      "How would a custom endpoint help?",
      "What would make you keep the read on the writer?",
    ],
    redFlags: [
      "Moves every read to a replica without checking consistency.",
      "Assumes a plain SELECT takes row locks.",
      "Ignores pool reconnection.",
    ],
    rubric: [
      "Distinguishes locking reads from plain reads.",
      "Chooses reader or custom endpoint for read-only work.",
      "Keeps read-after-write on the writer.",
      "Names pg_locks and wait events.",
    ],
  },
  {
    id: "endpoint-choice",
    question: "When would you use an instance endpoint or a custom endpoint instead of the reader endpoint?",
    difficulty: 3,
    hints: [
      "Instance endpoints are for precision, not scale.",
      "Custom endpoints group instances by capacity or role.",
    ],
    answer:
      "I would use an instance endpoint to diagnose or tune one specific replica, or to pin a workload that must stay on a known instance for a short period. I would use a custom endpoint when I need a stable name for a subset of instances, such as larger replicas for reporting or a group that excludes a replica with a different configuration. The reader endpoint is better for general read scaling because it follows the cluster membership and balances new connections. The cost of a custom or instance endpoint is that I own the membership and failover behavior, so it needs a runbook and a check that the target set is still healthy.",
    followUps: [
      "What happens to an instance endpoint when the instance is replaced?",
      "How would you test a custom endpoint after a failover?",
      "Why not use the writer endpoint for everything?",
    ],
    redFlags: [
      "Uses instance endpoints for general read scaling.",
      "Assumes custom endpoints fail over automatically.",
      "Ignores the operational cost of pinning.",
    ],
    rubric: [
      "Names diagnosis and pinned workloads.",
      "Explains custom endpoint grouping.",
      "Contrasts with reader endpoint behavior.",
      "Plans for membership and failover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each workload has a named endpoint and a documented consistency requirement.",
      "Read-only pools use the reader or a custom endpoint; writes use the writer endpoint.",
      "Pool reconnect behavior is tested after a failover or replica replacement.",
      "Per-replica utilization and lag are monitored, not only the cluster average.",
      "The team knows which reads take locks and which merely consume resources.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the connection string and pool host before resizing the database.",
      "Compare writer and reader utilization together.",
      "Check pg_stat_activity and pg_locks for the read query's actual behavior.",
      "Move read-only traffic and recycle pools; verify that connections landed on replicas.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add or adjust custom endpoints for workloads with different capacity or freshness needs.",
      "Recheck reader balance after adding replicas or changing pool sizes.",
      "Document the endpoint choice and the reason for any pinned connection.",
      "Review whether the writer size is still justified after routing is fixed.",
    ],
  },
];

const references = [
  {
    title: "Amazon Aurora DB clusters",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Writer and reader instances, the shared cluster volume, and up to 15 Aurora Replicas.",
  },
  {
    title: "Amazon Aurora endpoint connections",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Overview.Endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Writer, reader, instance, and custom endpoints, and how they behave during failover.",
  },
  {
    title: "Reader endpoints for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Endpoints.Reader.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection-level balancing, the no-replica case, and the difference from query-level routing.",
  },
  {
    title: "Working with DB instance read replicas",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Asynchronous replication, separate replica storage, and the difference from a Multi-AZ standby.",
  },
  {
    title: "Multi-AZ DB instance deployments for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Synchronous standby replication and why a standby cannot serve read traffic.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rds-aurora-arch": {
      model: topologyModel,
      presets,
      instructions:
        "Start healthy, then apply Reads on the writer. Compare writer and reader utilization, move the routing slider, and watch the writer recover. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Capacities, latencies, and thresholds are teaching values, not RDS or Aurora limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-consistency-models",
    "databases-primary-replica-lag",
    "databases-read-replica-routing",
    "databases-failover-dns",
  ],
};
