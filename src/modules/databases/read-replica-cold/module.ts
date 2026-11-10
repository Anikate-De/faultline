import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "replicaDataGb",
    label: "Data to replay",
    min: 20,
    max: 2_000,
    step: 20,
    value: 40,
    unit: " GB",
    group: "Replica",
    help: "Write-ahead log or apply backlog the new replica must consume before it is current. A larger dataset or longer snapshot restore means more replay.",
    format: "number" as const,
  },
  {
    id: "replayGbPerMin",
    label: "Replay rate",
    min: 1,
    max: 120,
    step: 1,
    value: 30,
    unit: " GB/min",
    group: "Replica",
    help: "How fast the replica can apply backlog when nothing competes with it. Reads served too early reduce this rate.",
    format: "number" as const,
  },
  {
    id: "warmupSeconds",
    label: "Cache warmup",
    min: 10,
    max: 600,
    step: 10,
    value: 30,
    unit: " s",
    group: "Replica",
    help: "Time for the replica's cache to reach a useful hit rate under read traffic.",
    format: "number" as const,
  },
  {
    id: "routeReadsPct",
    label: "Reads routed to replica",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Routing",
    help: "Share of read traffic sent to the new replica. Routing before catch-up and warmup makes latency worse and slows replay.",
    format: "percent" as const,
  },
  {
    id: "readRps",
    label: "Total read traffic",
    min: 100,
    max: 5_000,
    step: 50,
    value: 400,
    unit: " req/s",
    group: "Workload",
    help: "Application reads that could be routed. The replica only sees the routed share.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  data: number;
  replay: number;
  warmup: number;
  route: number;
  readRps: number;
  warmFraction: number;
  cacheHit: number;
  interference: number;
  effectiveReplay: number;
  remainingGb: number;
  lag: number;
  routedRps: number;
  readP99: number;
  health: Health;
}

function compute(p: Params, t: number): Computed {
  const data = Math.max(1, num(p, "replicaDataGb", 40));
  const replay = Math.max(0.5, num(p, "replayGbPerMin", 30));
  const warmup = Math.max(1, num(p, "warmupSeconds", 30));
  const route = clamp(num(p, "routeReadsPct", 0) / 100);
  const readRps = Math.max(0, num(p, "readRps", 400));
  const warmFraction = route > 0 ? clamp(t / warmup) : 0;
  const cacheHit = 5 + 90 * warmFraction;
  const interference = route * (1 - warmFraction) * 0.4;
  const effectiveReplay = replay * (1 - interference);
  const replayed = (effectiveReplay * t) / 60;
  const remainingGb = Math.max(0, data - replayed);
  const lag = Math.min(3_600, (remainingGb / replay) * 60);
  const routedRps = readRps * route;
  const readP99 = 4 + route * (1 - cacheHit / 100) * 300;
  const health: Health = lag >= 120 || readP99 >= 400 ? "crit" : lag >= 30 || readP99 >= 100 ? "warn" : "ok";
  return {
    data,
    replay,
    warmup,
    route,
    readRps,
    warmFraction,
    cacheHit,
    interference,
    effectiveReplay,
    remainingGb,
    lag,
    routedRps,
    readP99,
    health,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["replica-lag", values.lag, 0.3],
    ["read-p99", values.readP99, 0.3],
    ["cache-hit", values.cacheHit, 0.2],
    ["replay-remaining", values.remainingGb, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const values = compute(p, t);
  return {
    t,
    nodes: [
      {
        id: "primary",
        label: "Primary",
        kind: "db",
        role: "primary",
        health: "ok",
        sublabel: `${formatCount(values.readRps)} reads/s offered`,
        detail:
          "The primary still serves writes and the reads not routed to the replica. Adding a cold replica does not reduce the primary's work until the replica is actually serving.",
        meta: { view: "replication" },
      },
      {
        id: "replica",
        label: "New replica",
        kind: "db",
        role: "replica",
        health: values.health,
        utilization: clamp(values.remainingGb / Math.max(1, values.data)),
        sublabel: `${values.lag.toFixed(0)}s behind · ${Math.round(values.cacheHit)}% cache`,
        detail: `${Math.round(values.remainingGb)} GB of backlog remains. ${
          values.route > 0
            ? `Reads are routed at ${Math.round(values.route * 100)}%, and cold misses reduce replay to ${values.effectiveReplay.toFixed(
                1,
              )} GB/min.`
            : "Reads are not routed yet, so replay runs at full rate."
        }`,
        meta: { view: "replication", lag: values.lag, cache: values.cacheHit },
      },
    ],
    edges: [
      edge(
        "primary-replica",
        "primary",
        "replica",
        clamp(values.effectiveReplay / 120),
        values.health,
        "replay",
      ),
      edge("replica-reads", "replica", "primary", clamp(values.routedRps / 5_000), values.health, "routed reads"),
    ],
    metrics: [
      metric("replica-lag", "Replica lag", values.lag, "s", 30, 120, "number"),
      metric("read-p99", "Routed read p99", values.readP99, " ms", 100, 400, "ms"),
      metric("cache-hit", "Replica cache hit", values.cacheHit, "%", undefined, undefined, "percent"),
      metric("replay-remaining", "Backlog remaining", values.remainingGb, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${Math.round(values.remainingGb)} GB left to replay; lag ${values.lag.toFixed(
      0,
    )}s; cache ${Math.round(values.cacheHit)}%; routed p99 ${Math.round(values.readP99)} ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replica-lag",
    metricId: "replica-lag",
    warn: 30,
    crit: 120,
    title: "The new replica is still replaying backlog",
    cause:
      "A new replica starts from a snapshot and must apply the write-ahead log produced since that snapshot. If reads are routed before it catches up, the replica is stale and its reads can be inconsistent.",
    fix:
      "Wait for catch-up before routing, or route a small canary share and gate on lag. Do not send the full read load to a replica that is still replaying.",
    checkFirst: [
      "Check remaining backlog and replay rate before routing reads.",
      "Check whether the replica is also serving reads that compete with replay.",
      "Compare the replica's lag with the read-freshness requirement.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 100,
    crit: 400,
    title: "Routed reads are hitting a cold cache",
    cause:
      "The replica's cache is empty after creation. Reads that miss must fetch pages from storage, and the increased I/O also slows the apply process.",
    fix:
      "Warm the cache with a small, tolerant read share, wait for the hit rate to rise, and only then increase routing. Keep the primary serving latency-sensitive reads in the meantime.",
    checkFirst: [
      "Check the replica's cache hit rate and storage read latency.",
      "Check whether routing began before the replica was current.",
      "Compare the same query on the primary and the new replica.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const coldReplicaModel: SimModel = {
  id: "databases-read-replica-cold",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const t = frame.t + dt;
    const values = compute(p, t);
    const next = buildFrame(p, t, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.lag >= 120 && values.route > 0 && frame.flags.coldLogged !== 1) {
      pushEvent(next, {
        id: "cold-replica-reads",
        at: t,
        severity: "crit",
        title: "Cold replica is serving reads while replaying",
        detail: `${Math.round(values.route * 100)}% of reads hit a ${Math.round(
          values.cacheHit,
        )}% cache while ${Math.round(values.remainingGb)} GB of backlog remains; lag is ${Math.round(
          values.lag,
        )}s.`,
        nodeId: "replica",
        metricId: "read-p99",
      });
    }
    next.flags.coldLogged = values.lag >= 120 && values.route > 0 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 30);
    return [
      `After 30 seconds, about ${Math.round(values.remainingGb)} GB of the ${Math.round(
        values.data,
      )} GB backlog remains at a ${values.replay} GB/min replay rate.`,
      values.route > 0
        ? `Routing ${Math.round(values.route * 100)}% of reads at ${formatCount(
            values.routedRps,
          )} req/s reduces effective replay to ${values.effectiveReplay.toFixed(
            1,
          )} GB/min while the cache is cold.`
        : "No reads are routed yet, so replay runs at full rate and the cache does not warm from application traffic.",
      `Cache hit is ${Math.round(values.cacheHit)}% and routed p99 is ${Math.round(
        values.readP99,
      )} ms. The same query on a warm replica would avoid most of the storage fetch.`,
      "Routing should be gated on both lag and cache warmth. Lag alone can be acceptable while the cache is still cold, and a warm cache does not make stale data fresh.",
      "A new replica is not free capacity during an incident. It consumes replay I/O and primary bandwidth before it can serve reads, which is why adding one can make latency worse.",
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
    description: "A 40 GB backlog replays at 30 GB/min, and reads are routed only after the cache warms.",
    tone: "ok",
    elapsed: 60,
    params: defaults({ replicaDataGb: 40, replayGbPerMin: 60, warmupSeconds: 20, routeReadsPct: 100, readRps: 300 }),
  },
  {
    id: "peak",
    label: "Early routing",
    description: "A 60 GB backlog meets full read routing after 20 seconds; lag and p99 both enter warning.",
    tone: "warn",
    elapsed: 20,
    params: defaults({ replicaDataGb: 60, replayGbPerMin: 40, warmupSeconds: 120, routeReadsPct: 100, readRps: 800 }),
  },
  {
    id: "failure",
    label: "Cold replica, full load",
    description: "An 800 GB backlog is routed at full read load; cold misses slow replay and lag climbs past two minutes.",
    tone: "crit",
    elapsed: 30,
    params: defaults({ replicaDataGb: 800, replayGbPerMin: 8, warmupSeconds: 600, routeReadsPct: 100, readRps: 1_200 }),
  },
  {
    id: "warm-first",
    label: "Warm first",
    description: "The replica catches up before reads are routed, then serves with a warm cache.",
    tone: "ok",
    elapsed: 60,
    params: defaults({ replicaDataGb: 40, replayGbPerMin: 60, warmupSeconds: 20, routeReadsPct: 20, readRps: 400 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A small backlog, fast replay, and a warm cache keep both lag and p99 below warning.",
    tone: "ok",
    elapsed: 60,
    params: defaults({ replicaDataGb: 20, replayGbPerMin: 60, warmupSeconds: 20, routeReadsPct: 100, readRps: 400 }),
  },
];

const experiment: Experiment = {
  id: "replica-made-it-worse",
  title: "Why the new replica increased latency",
  simId: "read-replica-cold",
  question:
    "During a read-heavy incident you add a new replica and route all reads to it. Latency gets worse. What is the most likely reason?",
  prediction: {
    options: [
      { id: "replica-stale", label: "The replica is stale, so queries return wrong answers faster." },
      { id: "cold", label: "The replica is replaying backlog with a cold cache; early reads miss storage and slow replay." },
      { id: "network", label: "The replica is in a different Region, so every read pays cross-Region latency." },
      { id: "primary", label: "The primary is now doing more work because the replica exists." },
    ],
    correctOptionId: "cold",
    explanation:
      "A new replica starts from a snapshot and has to replay the log produced since then. Its cache is empty. Routing reads immediately sends queries to cold storage, and those reads compete with replay, so lag grows and p99 rises. Staleness would produce old data, not faster queries; the Region and primary explanations do not match a new replica in the same Region.",
  },
  setup: defaults({ replicaDataGb: 800, replayGbPerMin: 8, warmupSeconds: 600, routeReadsPct: 100, readRps: 1_200 }),
  runFor: 30,
  observe: [
    "About 796 GB of backlog remains after 30 seconds, and lag is over 90 minutes.",
    "The cache hit rate is under 10%, so routed p99 is about 275 ms.",
    "Reads routed at full load reduce effective replay while the cache is cold.",
    "Waiting and routing gradually would keep the primary serving until the replica is ready.",
  ],
  explain:
    "A read replica is a copy plus a replay process, not an instantly warm peer. The snapshot is old by the time it restores, and the new host has none of the primary's cache. Routing reads before catch-up and warmup sends work to the coldest possible node and competes with the replay that would make it useful.",
  fix: defaults({ replicaDataGb: 40, replayGbPerMin: 60, warmupSeconds: 20, routeReadsPct: 20, readRps: 400 }),
  debrief:
    "With a small backlog, fast replay, and only 20% of reads routed, the replica catches up and warms its cache while the primary carries the rest. Latency stays low and the replica earns more traffic gradually. The tradeoff is a slower capacity increase during the incident, which is usually better than making the incident worse.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cold read replica is a newly created copy that has not caught up or warmed its cache. It starts from a snapshot of the primary and then applies the write-ahead log (WAL) produced since that snapshot. Until replay reaches the primary's current point, the replica is behind. Until its cache fills with the working set, its reads are slower than a warm replica's.",
  },
  {
    type: "p",
    text: "Those are two independent gates. Lag measures freshness: how far the replica is behind the primary. Cache hit measures speed: whether the pages a query needs are in memory. A replica can be current and still slow because its cache is cold, and it can have a warm cache while still being behind on replay. Routing reads needs both gates to be acceptable.",
  },
  {
    type: "p",
    text: "Adding a replica during an incident also adds load. The new host consumes replay I/O, network bandwidth from the primary, and storage reads. If application reads are routed immediately, they compete with replay for the same I/O and can make the replica fall further behind. The capacity you hoped to add arrives later than the traffic you sent to it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The primary writes WAL and serves reads. The replica restores a snapshot, starts replay, and then accepts read connections. The load balancer or application routing layer decides when to send traffic. A safe sequence is: create the replica, wait for lag to approach zero, send a small read share to warm the cache, watch p99, and only then increase the share.",
  },
  {
    type: "table",
    headers: ["Gate", "What it measures", "Risk if ignored"],
    rows: [
      ["Replay backlog", "Freshness versus the primary", "Stale reads and an increasing gap"],
      ["Cache warmth", "Whether pages are in memory", "Slow reads and more storage I/O"],
      ["Read share", "Traffic sent to the new replica", "Replay competition and p99 regression"],
      ["Primary load", "What still depends on the primary", "No relief if routing is too cautious"],
      ["Failover role", "Whether the replica can be promoted", "A second stale copy in a real incident"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replica lag: warning at 30 seconds and critical at 120 in this model.",
      "Routed read p99: warning at 100 ms and critical at 400 ms as cold misses hit storage.",
      "Cache hit rate, which rises as the replica serves traffic.",
      "Backlog remaining in GB, which shows progress toward freshness independent of the lag number.",
      "A routing share slider, which changes both read latency and replay interference.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Cold replica, full load. Read backlog and cache hit before p99. Lower the routing share and rerun to see the replica catch up. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Backlog sizes, replay rates, and latency values are illustrative teaching numbers. Real catch-up time depends on the snapshot size, WAL volume, network, storage, and the read workload on the replica.",
  },
  { type: "sim", simId: "read-replica-cold" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The new replica had 800 GB of backlog at an 8 GB/min replay rate, and all reads were routed immediately. Cold misses sent queries to storage and competed with replay, so effective replay fell further. Lag stayed above 90 minutes and routed p99 sat around 275 ms. The replica was doing exactly what a cold copy does: replaying and missing cache.",
  },
  {
    type: "p",
    text: "Reducing the backlog, replaying faster, and routing only a small share let the replica catch up and warm its cache. Latency fell and the primary kept serving the rest. The new capacity arrived in stages rather than all at once, which is slower but does not turn a read incident into a larger one.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Replica lag and replay position, compared with the primary's current WAL position.",
      "Cache hit ratio and storage read latency on the new replica.",
      "Read p99 by endpoint, split between the primary and the new replica.",
      "Replay throughput, which falls when read traffic competes for I/O.",
      "Connection counts and routing weights, which show when traffic actually moved.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check backlog and cache hit together before routing reads. If lag is still high, the replica is not ready for consistent reads. If cache hit is low, it may be current but slow. Route a small share, watch p99 and replay throughput, and increase only when both improve.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Wait for replay to approach the primary before sending production reads.",
      "Warm the cache with a small, latency-tolerant read share.",
      "Gate routing on both lag and p99, not on the replica's existence.",
      "Keep the primary serving latency-sensitive reads until the replica is warm.",
      "Increase the read share gradually and watch replay throughput for interference.",
      "If the replica falls behind, reduce its read share before adding more replicas.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Waiting for catch-up delays the capacity you added, but routing early can make latency worse.",
      "A gradual read share protects p99 but leaves the primary carrying more load for longer.",
      "A larger replica cache warms faster but costs memory and may not match the primary's working set.",
      "Adding more cold replicas multiplies replay and snapshot load without adding warm capacity immediately.",
      "Promoting an uncaught-up replica in a failover keeps its lag as data loss, so catch-up matters beyond reads.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-worse",
    question: "You add a read replica during an incident and latency gets worse. Why?",
    difficulty: 2,
    hints: [
      "Two gates: freshness and cache.",
      "Reads compete with replay.",
    ],
    answer:
      "The new replica is likely still replaying its backlog and has a cold cache. Routing reads to it sends queries to storage and consumes I/O that replay needs, so lag grows while read latency rises. I would check backlog, cache hit rate, and replay throughput, then reduce the read share and let it catch up before routing more traffic.",
    followUps: [
      "Which metric tells you it is ready?",
      "How would you warm it safely?",
      "What if the primary cannot carry the reads?",
    ],
    redFlags: [
      "Assumes a new replica is instantly warm.",
      "Routes all reads at once.",
      "Ignores replay competition.",
    ],
    rubric: [
      "Names catch-up and cold cache.",
      "Explains replay competition.",
      "Checks both gates.",
      "Reduces the read share.",
    ],
  },
  {
    id: "route-sequence",
    question: "What sequence do you use to route reads to a newly added replica?",
    difficulty: 3,
    hints: [
      "Freshness first, then warmth, then volume.",
      "Use a gate and a canary share.",
    ],
    answer:
      "I would wait for replay to approach the primary, then send a small read share that tolerates latency to warm the cache. I would watch lag, cache hit, p99, and replay throughput, and increase the share only if all stay acceptable. The gates are lag for freshness and p99 for warmth; the replica's existence is not a gate. If either regresses, I would reduce the share rather than add another cold replica.",
    followUps: [
      "What share would you start with?",
      "How long would you wait at each step?",
      "How does read-after-write affect the sequence?",
    ],
    redFlags: [
      "Routes all traffic immediately.",
      "Uses only lag as a gate.",
      "Ignores p99.",
    ],
    rubric: [
      "Waits for catch-up.",
      "Warms with a small share.",
      "Gates on lag and p99.",
      "Increases gradually.",
    ],
  },
  {
    id: "capacity-during-incident",
    question: "The primary is overloaded and you need read capacity now. What are the alternatives to a cold replica?",
    difficulty: 3,
    hints: [
      "Not every read needs the same freshness.",
      "Caching and query reduction can be faster than a new replica.",
    ],
    answer:
      "I would first reduce read work: cache stable data, batch or deduplicate queries, and move reporting off the primary. If I need another database copy, I would check whether an existing warm replica has headroom before adding a cold one. A new replica still has to catch up and warm, so it is not immediate capacity; it is capacity that arrives in stages. For urgent relief, shedding or caching usually helps sooner.",
    followUps: [
      "Which reads can tolerate staleness?",
      "How would you measure cache effectiveness?",
      "When is a warm replica the right answer?",
    ],
    redFlags: [
      "Adds a cold replica and routes all reads.",
      "Ignores caching.",
      "Treats a replica as instant capacity.",
    ],
    rubric: [
      "Reduces read work first.",
      "Checks existing warm replicas.",
      "Explains staged capacity.",
      "Considers staleness.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Replica creation and catch-up time are measured, not assumed.",
      "Read routing has a gate on lag and cache hit or p99.",
      "A small canary share exists for warming a new replica.",
      "The primary has headroom to carry reads during catch-up.",
      "Replica promotion and lag are part of the failover plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check backlog and cache before routing reads.",
      "Route a small share and watch replay throughput.",
      "Reduce the share if lag or p99 regresses.",
      "Keep latency-sensitive reads on the primary until the replica is warm.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record catch-up time and the read share ramp.",
      "Retune snapshot size, replay capacity, and cache for the next replica.",
      "Verify the replica's promotion readiness.",
      "Update the routing gate with the measured p99.",
    ],
  },
];

const references = [
  {
    title: "Working with read replicas for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Creating read replicas, replication lag, and promotion behavior.",
  },
  {
    title: "PostgreSQL: Hot Standby",
    url: "https://www.postgresql.org/docs/current/hot-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Read-only queries on a standby, replay conflicts, and lag during recovery.",
  },
  {
    title: "Amazon Aurora reader endpoints",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Endpoints.Reader.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How the reader endpoint distributes connections and why a new reader is not instantly warm.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-replica-cold": {
      model: coldReplicaModel,
      presets,
      instructions:
        "Start healthy, apply Cold replica, full load, and read backlog and cache hit before p99. Lower the routing share and rerun to see catch-up. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Backlog sizes, replay rates, warmup times, and thresholds are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-read-replica-routing",
    "databases-primary-replica-lag",
    "databases-replication-threads",
    "databases-read-after-write",
  ],
};
