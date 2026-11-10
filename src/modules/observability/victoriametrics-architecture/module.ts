import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INSERT_CAPACITY = 180_000;
const STORAGE_CAPACITY = 300_000;
const SELECT_CAPACITY = 100;
const REPLICATION_FACTOR = 2;
const QUERY_TIMEOUT_MS = 20_000;

const params = [
  {
    id: "ingestRate",
    label: "Ingest rate",
    min: 50_000,
    max: 2_000_000,
    step: 50_000,
    value: 300_000,
    unit: " samples/s",
    scale: "log" as const,
    group: "Ingest",
    help: "Samples per second arriving at vminsert from all agents.",
    format: "rps" as const,
  },
  {
    id: "insertReplicas",
    label: "vminsert replicas",
    min: 2,
    max: 20,
    step: 1,
    value: 6,
    unit: "",
    group: "Ingest",
    help: "Stateless routers that hash samples to vmstorage nodes.",
    format: "count" as const,
  },
  {
    id: "storageNodes",
    label: "vmstorage nodes",
    min: 2,
    max: 20,
    step: 1,
    value: 6,
    unit: "",
    group: "Storage",
    help: "Nodes that hold series and samples. Replication multiplies write work by two.",
    format: "count" as const,
  },
  {
    id: "selectReplicas",
    label: "vmselect replicas",
    min: 1,
    max: 10,
    step: 1,
    value: 3,
    unit: "",
    group: "Query",
    help: "Stateless query workers that fan out to storage and merge results.",
    format: "count" as const,
  },
  {
    id: "queryRate",
    label: "Query rate",
    min: 10,
    max: 2_000,
    step: 10,
    value: 200,
    unit: " qps",
    group: "Query",
    help: "Concurrent dashboard and alert queries per second.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  ingestRate: number;
  insertReplicas: number;
  storageNodes: number;
  selectReplicas: number;
  queryRate: number;
  insertCpu: number;
  storageCpu: number;
  selectCpu: number;
  insertLoad: number;
  storageLoad: number;
  selectLoad: number;
  queryP95: number;
  ingestLag: number;
}

function compute(p: Params): Computed {
  const ingestRate = Math.max(1, num(p, "ingestRate", 300_000));
  const insertReplicas = Math.max(1, Math.round(num(p, "insertReplicas", 6)));
  const storageNodes = Math.max(1, Math.round(num(p, "storageNodes", 6)));
  const selectReplicas = Math.max(1, Math.round(num(p, "selectReplicas", 3)));
  const queryRate = Math.max(1, num(p, "queryRate", 200));
  const insertLoad = (ingestRate / (insertReplicas * INSERT_CAPACITY)) * 100;
  const storageLoad = (ingestRate * REPLICATION_FACTOR / (storageNodes * STORAGE_CAPACITY)) * 100;
  const selectLoad = (queryRate / (selectReplicas * SELECT_CAPACITY)) * 100;
  const insertCpu = Math.min(100, insertLoad);
  const storageCpu = Math.min(100, storageLoad);
  const selectCpu = Math.min(100, selectLoad);
  const selectShare = clamp(selectLoad / 100, 0, 0.995);
  const queryP95 = Math.min(QUERY_TIMEOUT_MS, 25 + (100 * selectShare ** 3) / (1 - selectShare));
  const ingestLag = Math.min(
    120,
    Math.max(0, insertLoad - 80) * 0.8 + Math.max(0, storageLoad - 80) * 0.4,
  );
  return {
    ingestRate,
    insertReplicas,
    storageNodes,
    selectReplicas,
    queryRate,
    insertCpu,
    storageCpu,
    selectCpu,
    insertLoad,
    storageLoad,
    selectLoad,
    queryP95,
    ingestLag,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function cpuText(load: number, cpu: number): string {
  if (cpu < 100) return `${cpu.toFixed(0)}% CPU`;
  const multiple = load / 100;
  return `100% CPU (${multiple.toFixed(multiple >= 10 ? 0 : 1)}× modeled capacity)`;
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["query-p95", values.queryP95],
    ["vmselect-cpu", values.selectCpu],
    ["vminsert-cpu", values.insertCpu],
    ["vmstorage-cpu", values.storageCpu],
    ["ingest-lag", values.ingestLag],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.4);
      return Math.max(0, value * (0.97 + 0.03 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const insertHealth = healthFor(values.insertCpu, 70, 85);
  const storageHealth = healthFor(values.storageCpu, 70, 85);
  const selectHealth = healthFor(values.selectCpu, 70, 85);
  const queryHealth = healthFor(values.queryP95, 400, 900);
  return {
    t: 0,
    nodes: [
      {
        id: "agents",
        label: "vmagent fleet",
        kind: "client",
        health: "ok",
        utilization: clamp(values.ingestRate / 2_000_000),
        sublabel: `${Math.round(values.ingestRate).toLocaleString()} samples/s`,
        detail: "Agents scrape and ship samples; they do not decide where a series is stored.",
        meta: { view: "flow" },
      },
      {
        id: "vminsert",
        label: "vminsert",
        kind: "stream",
        health: insertHealth,
        utilization: values.insertCpu / 100,
        sublabel: `${values.insertCpu.toFixed(0)}% CPU`,
        detail: `Stateless routers hash samples to storage. Illustrative capacity is ${INSERT_CAPACITY.toLocaleString()} samples/s per replica.`,
        meta: { view: "flow" },
      },
      {
        id: "vmstorage",
        label: "vmstorage",
        kind: "storage",
        health: storageHealth,
        utilization: values.storageCpu / 100,
        sublabel: `${values.storageCpu.toFixed(0)}% write CPU`,
        detail: `Stores series and samples. The model assumes replication factor ${REPLICATION_FACTOR}; capacity is ${STORAGE_CAPACITY.toLocaleString()} samples/s per node.`,
        meta: { view: "flow" },
      },
      {
        id: "vmselect",
        label: "vmselect",
        kind: "service",
        health: selectHealth,
        utilization: values.selectCpu / 100,
        sublabel: `${values.selectCpu.toFixed(0)}% CPU`,
        detail: `Fetches from all configured vmstorage nodes and merges the results. Illustrative capacity is ${SELECT_CAPACITY} qps per replica.`,
        meta: { view: "flow" },
      },
      {
        id: "dashboards",
        label: "Dashboards and alerts",
        kind: "service",
        health: queryHealth,
        utilization: clamp(values.queryP95 / 900),
        sublabel: `p95 ${values.queryP95.toFixed(0)}ms`,
        detail: `Query latency is capped by a ${QUERY_TIMEOUT_MS / 1_000}s model timeout when vmselect is saturated.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("agents-insert", "agents", "vminsert", clamp(values.ingestRate / 2_000_000)),
      edge("insert-storage", "vminsert", "vmstorage", clamp(values.ingestRate / 2_000_000), insertHealth),
      edge("storage-select", "vmstorage", "vmselect", clamp(values.queryRate / 2_000), storageHealth),
      edge("select-dashboard", "vmselect", "dashboards", clamp(values.queryRate / 2_000), selectHealth),
    ],
    metrics: [
      metric("query-p95", "Query p95", values.queryP95, "ms", 400, 900, "ms"),
      metric("vmselect-cpu", "vmselect CPU", values.selectCpu, "%", 70, 85, "percent"),
      metric("vminsert-cpu", "vminsert CPU", values.insertCpu, "%", 70, 85, "percent"),
      metric("vmstorage-cpu", "vmstorage write CPU", values.storageCpu, "%", 70, 85, "percent"),
      metric("ingest-lag", "Ingest lag", values.ingestLag, "s", 5, 20, "number"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: `vmselect ${values.selectCpu.toFixed(0)}% CPU, query p95 ${values.queryP95.toFixed(0)}ms; vminsert ${values.insertCpu.toFixed(0)}%, vmstorage ${values.storageCpu.toFixed(0)}%; ingest lag ${values.ingestLag.toFixed(1)}s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 400,
    crit: 900,
    title: "Query latency breached the dashboard budget",
    cause:
      "vmselect is spending too long fanning out and merging results. Ingest and storage can be healthy because the query path has its own capacity limit.",
    fix:
      "Add vmselect replicas, reduce query fan-out or concurrency, or split heavy dashboards. Adding storage nodes does not fix a query-worker bottleneck.",
    checkFirst: [
      "Compare vmselect CPU with vminsert and vmstorage CPU.",
      "Check query concurrency and the heaviest dashboard panels.",
      "Check whether one tenant or query pattern dominates the fan-out.",
    ],
  },
  {
    id: "vmselect-cpu",
    metricId: "vmselect-cpu",
    warn: 70,
    crit: 85,
    title: "vmselect is saturated",
    cause:
      "Query workers are stateless and scale horizontally, but each replica has a finite merge and fan-out capacity. More queries or wider queries exhaust it.",
    fix:
      "Scale vmselect horizontally and reduce expensive queries. Check whether a single dashboard or alert rule is issuing a burst.",
    checkFirst: [
      "Check query rate per vmselect replica.",
      "Check the slow-query log or query stats.",
      "Check for a dashboard refresh loop or a retrying alert.",
    ],
  },
  {
    id: "vminsert-cpu",
    metricId: "vminsert-cpu",
    warn: 70,
    crit: 85,
    title: "vminsert is the ingest bottleneck",
    cause:
      "Every sample passes through a stateless router. Too few replicas, or a traffic burst, raises CPU before storage is full.",
    fix:
      "Add vminsert replicas and check for a single agent or tenant sending a disproportionate share. Ingest lag follows if the routers cannot keep up.",
    checkFirst: [
      "Compare per-replica ingest CPU.",
      "Check for a recent scrape interval change or new high-volume target.",
      "Check ingest lag and agent retry volume.",
    ],
  },
  {
    id: "vmstorage-cpu",
    metricId: "vmstorage-cpu",
    warn: 70,
    crit: 85,
    title: "vmstorage write pressure is high",
    cause:
      "Replication multiplies writes, and each storage node owns a share of the series. Uneven series distribution or a storage node loss can overload the remainder.",
    fix:
      "Add storage nodes for capacity, reduce series churn, or check replication and rebalancing. Storage scaling changes where data lives and has a migration cost.",
    checkFirst: [
      "Check per-node disk, CPU, and series count.",
      "Check whether a node is missing or read-only.",
      "Check whether the replication factor changed recently.",
    ],
  },
  {
    id: "ingest-lag",
    metricId: "ingest-lag",
    warn: 5,
    crit: 20,
    title: "Samples are arriving late",
    cause:
      "The ingest path is queueing before storage. This can be vminsert saturation, vmstorage write pressure, or a retrying agent; the lag alone does not say which.",
    fix:
      "Find the saturated component before adding capacity. If vminsert is hot, scale routers. If storage is hot, inspect node balance and write amplification.",
    checkFirst: [
      "Compare vminsert and vmstorage CPU.",
      "Check agent retry and queue metrics.",
      "Check whether lag is rising or stable.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const vmArchitectureModel: SimModel = {
  id: "observability-victoriametrics-architecture",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults());
    seedSeries(frame, compute(defaults()));
    frame.flags.seed = seed;
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p);
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.queryP95 >= 900 && frame.flags.queryEvent !== 1) {
      pushEvent(next, {
        id: "vmselect-query-saturation",
        at: frame.t,
        severity: "crit",
        title: "Queries time out while ingest is healthy",
        detail: `vmselect is saturated at 100% CPU (${(values.selectLoad / 100) % 1 === 0 ? (values.selectLoad / 100).toFixed(0) : (values.selectLoad / 100).toFixed(1)}× modeled query capacity) with p95 ${values.queryP95.toFixed(0)}ms. vminsert is ${values.insertCpu.toFixed(0)}% and vmstorage ${values.storageCpu.toFixed(0)}%, so the bottleneck is the query path.`,
        nodeId: "vmselect",
        metricId: "query-p95",
      });
      next.flags.queryEvent = 1;
    }
    if (values.queryP95 < 900) next.flags.queryEvent = 0;
    next.summary = `vmselect ${values.selectCpu.toFixed(0)}% CPU, query p95 ${values.queryP95.toFixed(0)}ms; vminsert ${values.insertCpu.toFixed(0)}%, vmstorage ${values.storageCpu.toFixed(0)}%; ingest lag ${values.ingestLag.toFixed(1)}s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Ingest is ${values.ingestRate.toLocaleString()} samples/s through ${values.insertReplicas} vminsert replicas: ${cpuText(values.insertLoad, values.insertCpu)} each.`,
    );
    items.push(
      `Replication factor ${REPLICATION_FACTOR} turns that into ${Math.round(values.ingestRate * REPLICATION_FACTOR).toLocaleString()} writes/s across ${values.storageNodes} storage nodes: ${cpuText(values.storageLoad, values.storageCpu)} each.`,
    );
    items.push(
      `Queries are ${values.queryRate.toLocaleString()} qps through ${values.selectReplicas} vmselect replica${values.selectReplicas === 1 ? "" : "s"}: ${cpuText(values.selectLoad, values.selectCpu)} and p95 ${values.queryP95.toFixed(0)}ms.`,
    );
    const bottleneck = [
      ["vminsert", values.insertLoad, values.insertCpu],
      ["vmstorage", values.storageLoad, values.storageCpu],
      ["vmselect", values.selectLoad, values.selectCpu],
    ].sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    items.push(
      `The highest component load is ${bottleneck[0]} at ${cpuText(Number(bottleneck[1]), Number(bottleneck[2]))}; scale that component first.`,
    );
    return items;
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
    description: "300k samples/s, balanced insert and storage, and a 3-replica query tier.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak query load",
    description: "Ingest rises to 900k samples/s and dashboards issue 500 qps. vmselect crosses warning.",
    tone: "warn",
    params: defaults({ ingestRate: 900_000, insertReplicas: 8, storageNodes: 10, selectReplicas: 6, queryRate: 500 }),
  },
  {
    id: "failure",
    label: "Query tier starved",
    description: "Ingest and storage are healthy, but one vmselect replica serves 900 qps. Queries time out.",
    tone: "crit",
    params: defaults({ ingestRate: 400_000, insertReplicas: 6, storageNodes: 6, selectReplicas: 1, queryRate: 900 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Add vmselect replicas and return query load to a supportable level.",
    tone: "ok",
    params: defaults({ ingestRate: 400_000, insertReplicas: 8, storageNodes: 8, selectReplicas: 6, queryRate: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-vm-bottleneck",
  title: "Predict which VictoriaMetrics component fails",
  simId: "vm-arch",
  question:
    "Ingest is 400k samples/s with six vminsert and six vmstorage nodes. Dashboards send 900 qps to a single vmselect replica. Which component crosses critical first?",
  prediction: {
    options: [
      { id: "select", label: "vmselect, because query fan-out and merging are saturated" },
      { id: "insert", label: "vminsert, because every sample must be routed" },
      { id: "storage", label: "vmstorage, because replication doubles the writes" },
      { id: "agents", label: "The agents, because they queue samples" },
    ],
    correctOptionId: "select",
    explanation:
      "Ingest and storage have spare capacity at this rate. vmselect is a separate stateless tier with its own per-replica query capacity. One replica for 900 qps saturates the merge path while vminsert and vmstorage remain below their warning thresholds.",
  },
  setup: defaults({ ingestRate: 400_000, insertReplicas: 6, storageNodes: 6, selectReplicas: 1, queryRate: 900 }),
  runFor: 20,
  observe: [
    "vmselect CPU crosses 85% while vminsert stays below 40% and vmstorage below 45%.",
    "Query p95 rises past the 900ms critical threshold and approaches the model timeout.",
    "Ingest lag stays at zero because the write path is not the constraint.",
    "Adding storage nodes would not lower the query latency because the bottleneck is the query worker.",
  ],
  explain:
    "VictoriaMetrics separates ingest, storage, and query into different process types. vminsert routes, vmstorage stores, and vmselect fans out and merges. Each tier has its own capacity. A query burst can time out while ingest is perfectly healthy, and the fix is to scale or reduce work in the query tier, not to add storage.",
  fix: defaults({ ingestRate: 400_000, insertReplicas: 8, storageNodes: 8, selectReplicas: 6, queryRate: 300 }),
  debrief:
    "Six vmselect replicas bring the query tier back below its warning threshold while ingest and storage stay comfortable. The cost is more query workers to operate and a larger fan-out surface. The lesson is to identify the tier before scaling; adding storage would have moved data without moving the bottleneck.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "VictoriaMetrics is a time-series database and monitoring system. In its cluster deployment, three process types do the work. vminsert receives samples and routes them to storage. vmstorage owns a share of the series and stores the samples on disk. vmselect receives queries, fetches from all configured vmstorage nodes, and merges the results. Each tier is stateless or sharded in a different way, so each has a different scaling limit.",
  },
  {
    type: "p",
    text: "That separation is the point and the trap. A slow query does not prove that storage is slow. Late samples do not prove that ingest is overloaded. The same cluster can be healthy on one path and failing on another, and the first useful question is which process type is saturated.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is agents, vminsert, vmstorage. The read path is dashboards or alerts, vmselect, vmstorage, then back through vmselect. vmstorage is the only stateful tier. vminsert and vmselect are stateless and can be replicated behind a load balancer. The model assumes a replication factor of two, which doubles write work before the storage nodes see it.",
  },
  {
    type: "table",
    headers: ["Component", "Role", "Scales with", "First signal"],
    rows: [
      ["vminsert", "Route samples to storage", "Replicas and ingest rate", "Ingest CPU and sample lag"],
      ["vmstorage", "Store series and samples", "Nodes, disk, and replication", "Write CPU, disk, per-node series"],
      ["vmselect", "Fan out and merge queries", "Replicas and query cost", "Query CPU and p95"],
      ["vmagent", "Scrape and ship samples", "Agents and target count", "Scrape lag and retry volume"],
    ],
  },
  {
    type: "p",
    text: "The capacities in this module are illustrative: 180,000 samples/s per vminsert replica, 300,000 per vmstorage node, and 100 qps per vmselect replica. They are not VictoriaMetrics limits or sizing guidance. The shape of the failure is the lesson: three tiers, three capacity curves, and one shared cluster that can look healthy from the wrong dashboard.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A five-node topology from agents through vminsert, vmstorage, vmselect, and dashboards.",
      "Per-component CPU for vminsert, vmstorage write work, and vmselect.",
      "Query p95 with warning at 400ms and critical at 900ms, capped by a 20s model timeout.",
      "Ingest lag, which rises when the write path rather than the query path is saturated.",
      "A causal event that names the query tier only when ingest and storage remain healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Query tier starved and compare vmselect CPU with vminsert and vmstorage. Then apply Recovery. Change only select replicas and watch p95 fall while the other tiers stay flat. Run the experiment before reading the debrief.",
  },
  {
    type: "p",
    text: "Do not treat a single cluster-wide CPU number as the health of the system. The tiers are separate. A query worker at 100% and a storage node at 40% describe a query problem, not a storage problem.",
  },
  { type: "sim", simId: "vm-arch" },
  { type: "experiment", experimentId: "predict-vm-bottleneck" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Ingest was 400,000 samples/s. With six vminsert replicas and six storage nodes at replication factor two, the write tiers stayed below half their capacity. The query tier had one vmselect replica for 900 qps. That replica fanned out and merged every query until its CPU crossed 85%, then p95 crossed 900ms and approached the model timeout.",
  },
  {
    type: "p",
    text: "The event named the query path because the other tiers were healthy. The recovery added vmselect replicas and reduced query load. Storage nodes were added too, but that was not what fixed the latency. Treating every VictoriaMetrics symptom as a storage problem is the mistake this module is designed to expose.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-process CPU and memory for vminsert, vmstorage, and vmselect, not a single cluster average.",
      "vmselect query duration and concurrency, plus the slow-query log or query statistics.",
      "vminsert sample rate, ingest lag, and agent retry or queue metrics.",
      "vmstorage disk usage, per-node series count, read-only state, and merge pressure.",
      "A rollout timeline: a dashboard refresh change, a new alert rule, or a scrape interval change often explains the step.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the three tiers before changing capacity. If vmselect is the only hot component, scale or reduce queries. If vminsert and ingest lag are rising together, look at the write path. If one storage node is hot or read-only, inspect balance and replication before adding nodes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the saturated tier from per-component CPU, latency, and lag.",
      "If vmselect is hot, add replicas and reduce expensive or repeated queries.",
      "If vminsert is hot, add replicas and check for a single high-volume sender.",
      "If vmstorage is hot, inspect per-node balance, disk, and replication before scaling.",
      "Verify that the fix lowered the original symptom, not only the component CPU.",
      "Watch the next tier after scaling; moving the bottleneck is common.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "vminsert and vmselect scale horizontally with little data movement, but each replica adds operational surface and load-balancer work.",
      "vmstorage scaling adds capacity but moves series and has a rebalancing cost; it also does not fix a query-worker bottleneck.",
      "Replication improves durability and read availability but doubles write work and disk use.",
      "Reducing query cost can mean dropping a dashboard or shortening a window, which changes what the team can see.",
      "A single cluster-wide health number hides the tier that is actually failing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "locate-tier",
    question:
      "Metrics arrive late and queries time out at the same time. How do you tell whether vminsert or vmselect is the cause?",
    difficulty: 3,
    hints: [
      "Late writes and slow reads can share a cause, but not always the same tier.",
      "Look for the component whose saturation precedes the symptom.",
    ],
    answer:
      "I would compare per-component signals over the same window. If vminsert CPU and ingest lag rise while vmselect is normal, the write path is the cause and the query timeout may be a downstream effect of an overloaded cluster or a retrying client. If vmselect CPU and query duration rise while vminsert and ingest lag are flat, the query path is the cause. I would also check vmstorage for a read-only or unbalanced node, because both paths depend on it. The decisive evidence is which tier saturates first and whether the other tier's symptom follows it.",
    followUps: [
      "What if both tiers are hot?",
      "Which metric would you put on the first dashboard row?",
      "How does replication change the write signal?",
    ],
    redFlags: [
      "Blames storage by default.",
      "Uses a cluster-wide CPU average.",
      "Changes capacity before locating the tier.",
    ],
    rubric: [
      "Compares per-component signals.",
      "Establishes a temporal order.",
      "Checks the shared storage tier.",
      "Names confirming and falsifying evidence.",
    ],
  },
  {
    id: "scale-storage",
    question:
      "Query p95 is 2s, vmselect is at 95% CPU, and vmstorage is at 35%. A teammate proposes adding storage nodes. What do you say?",
    difficulty: 2,
    hints: [
      "Storage and query are separate process types.",
      "Adding a stateful tier has a migration cost.",
    ],
    answer:
      "I would say it probably will not help. vmselect is the saturated tier; it fans out and merges queries before storage becomes the constraint. Adding vmstorage increases storage capacity and may redistribute series, but it does not add query workers or reduce the merge work per query. I would add vmselect replicas or reduce query cost first, then verify p95. If storage is also near a limit or unevenly loaded, it may need work later, but that is a separate decision with a rebalancing cost.",
    followUps: [
      "When would adding storage still help query latency?",
      "What query change would you try first?",
      "How would you verify the fix?",
    ],
    redFlags: [
      "Adds every tier at once.",
      "Assumes more storage means faster queries.",
      "Ignores query fan-out.",
    ],
    rubric: [
      "Identifies vmselect as the bottleneck.",
      "Explains the independent tiers.",
      "Names a query-side fix.",
      "States the verification.",
    ],
  },
  {
    id: "replication",
    question:
      "What does a replication factor of two change in this architecture, and what does it not fix?",
    difficulty: 3,
    hints: [
      "Replication is write amplification before storage.",
      "It is durability and availability, not query capacity.",
    ],
    answer:
      "Replication factor two means vminsert writes each sample to two storage nodes, so storage write work and disk use roughly double for the same ingest rate. It improves durability and can improve read availability if one replica is unavailable. It does not fix a saturated vmselect tier, and it does not reduce the number of series or the cost of a query. It also raises the importance of balanced placement, because losing a node shifts more work onto its peers.",
    followUps: [
      "How would you size storage for factor two?",
      "What happens during a storage node loss?",
      "Does replication change the query fan-out?",
    ],
    redFlags: [
      "Says replication adds query capacity.",
      "Ignores write amplification.",
      "Assumes replication replaces backups.",
    ],
    rubric: [
      "Explains write amplification.",
      "Separates durability from query capacity.",
      "Mentions node loss and balance.",
      "Does not confuse replication with backup.",
    ],
  },
  {
    id: "ingest-lag",
    question:
      "Ingest lag is 30s. vminsert CPU is 40%, vmstorage CPU is 92%, and one storage node is read-only. What is your sequence?",
    difficulty: 3,
    hints: [
      "A read-only node changes where writes can go.",
      "Lag is a symptom; find the component that cannot accept writes.",
    ],
    answer:
      "I would start with the read-only storage node because it changes the write topology. vminsert may be healthy while it retries or redirects writes away from that node, and the remaining nodes absorb more work. I would check disk space, merge state, and the node's logs, then restore or replace it. I would not add vminsert replicas first, because the routers are not the constraint. After recovery I would verify lag drains, per-node write CPU rebalances, and the replication factor still holds.",
    followUps: [
      "What would you check on the read-only node first?",
      "How does lag drain after the fix?",
      "What if no node is read-only?",
    ],
    redFlags: [
      "Scales vminsert because lag is present.",
      "Ignores the read-only state.",
      "Adds storage without checking disk.",
    ],
    rubric: [
      "Starts with the read-only node.",
      "Explains redirected write pressure.",
      "Checks disk and merge state.",
      "Verifies lag and balance after recovery.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show vminsert, vmstorage, and vmselect separately.",
      "Query duration, concurrency, and slow queries are visible per vmselect replica.",
      "Ingest lag and agent retry volume are charted with the write path.",
      "Storage disk, per-node series, read-only state, and replication are visible.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Locate the saturated tier before changing capacity.",
      "Compare the timing of ingest lag and query latency.",
      "Check the stateful tier for a read-only or unbalanced node.",
      "Scale the tier that is hot, not the tier that is easiest to resize.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the original symptom improved, not only component CPU.",
      "Check whether the bottleneck moved to another tier.",
      "Record the query or ingest change that triggered the incident.",
      "Review replication and storage balance after any node change.",
    ],
  },
];

const references = [
  {
    title: "VictoriaMetrics documentation",
    url: "https://docs.victoriametrics.com/victoriametrics/",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Architecture, components, and operational concepts.",
  },
  {
    title: "Cluster version",
    url: "https://docs.victoriametrics.com/victoriametrics/cluster-victoriametrics/",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "vminsert, vmstorage, vmselect, and replication.",
  },
  {
    title: "Single-node VictoriaMetrics",
    url: "https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Retention, downsampling, and storage behavior for comparison.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vm-arch": {
      model: vmArchitectureModel,
      presets,
      instructions:
        "Start Healthy, then apply Query tier starved. Compare vmselect CPU with vminsert and vmstorage. Apply Recovery and change only select replicas to see what actually fixes the latency.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Per-replica capacities, replication factor, and the 20s query timeout are teaching values, not VictoriaMetrics limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-victoriametrics-cardinality",
    "observability-victoriametrics-retention",
    "foundations-use-red",
    "foundations-linux-disk-io",
  ],
};
