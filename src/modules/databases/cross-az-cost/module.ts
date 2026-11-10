import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MONTH_SECONDS = 2_592_000;
const GB = 1_048_576;
const CROSS_AZ_PRICE_PER_GB = 0.01;

const params = [
  {
    id: "requestsPerSecond",
    label: "Application request rate",
    min: 100,
    max: 5_000,
    step: 50,
    value: 400,
    unit: " req/s",
    group: "Workload",
    help: "Requests that touch the database. Each request can issue several queries.",
    format: "rps" as const,
  },
  {
    id: "queriesPerRequest",
    label: "Queries per request",
    min: 1,
    max: 50,
    step: 1,
    value: 4,
    unit: " queries",
    group: "Workload",
    help: "Database round trips per request. A chatty ORM or an N+1 pattern multiplies both latency and transfer.",
    format: "count" as const,
  },
  {
    id: "crossAzShare",
    label: "Reads leaving the AZ",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Routing",
    help: "Share of reads routed to a reader in a different Availability Zone. Writes to a cross-AZ writer also cross a boundary.",
    format: "percent" as const,
  },
  {
    id: "responseKb",
    label: "Response size",
    min: 1,
    max: 64,
    step: 1,
    value: 2,
    unit: " KB",
    group: "Workload",
    help: "Average bytes returned per query. Large rows or wide SELECTs increase transfer in the response direction.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  queriesPerRequest: number;
  share: number;
  responseKb: number;
  crossAzQueriesPerSecond: number;
  transferGbMonth: number;
  monthlyCost: number;
  addedLatencyMs: number;
  localQueriesPerSecond: number;
  health: Health;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(0, num(p, "requestsPerSecond", 400));
  const queriesPerRequest = Math.max(1, num(p, "queriesPerRequest", 4));
  const share = clamp(num(p, "crossAzShare", 20) / 100);
  const responseKb = Math.max(0.1, num(p, "responseKb", 2));
  const totalQueries = requestRate * queriesPerRequest;
  const crossAzQueriesPerSecond = totalQueries * share;
  const kbPerSecond = crossAzQueriesPerSecond * (responseKb + 1);
  const transferGbMonth = (kbPerSecond * MONTH_SECONDS) / GB;
  const monthlyCost = transferGbMonth * CROSS_AZ_PRICE_PER_GB * 2;
  const addedLatencyMs = queriesPerRequest * share * 0.6;
  const health: Health =
    monthlyCost >= 1_500 || addedLatencyMs >= 5
      ? "crit"
      : monthlyCost >= 400 || addedLatencyMs >= 2
        ? "warn"
        : "ok";
  return {
    requestRate,
    queriesPerRequest,
    share,
    responseKb,
    crossAzQueriesPerSecond,
    transferGbMonth,
    monthlyCost,
    addedLatencyMs,
    localQueriesPerSecond: totalQueries * (1 - share),
    health,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatGb(value: number): string {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} TB`;
  return `${Math.round(value)} GB`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["cross-az-cost", values.monthlyCost, 1],
    ["cross-az-transfer", values.transferGbMonth, 0.2],
    ["added-latency", values.addedLatencyMs, 0.01],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const localReadRate = values.localQueriesPerSecond;
  const remoteReadRate = values.crossAzQueriesPerSecond;
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application · us-east-1a",
        kind: "service",
        health: values.health,
        sublabel: `${formatCount(values.requestRate)} req/s · ${values.queriesPerRequest} queries each`,
        detail:
          "The application task is in one AZ. Every query that reaches a node in another AZ crosses the zone boundary and is billed as data transfer.",
        meta: { view: "flow" },
      },
      {
        id: "reader-local",
        label: "Reader · us-east-1a",
        kind: "db",
        role: "replica",
        health: "ok",
        utilization: clamp(localReadRate / Math.max(1, values.requestRate * values.queriesPerRequest)),
        sublabel: `${formatCount(localReadRate)} queries/s · local`,
        detail: "A reader in the same AZ as the application avoids the cross-AZ hop for reads. It still consumes a connection and must be kept current by replication.",
        meta: { view: "flow" },
      },
      {
        id: "reader-remote",
        label: "Reader · us-east-1b",
        kind: "db",
        role: "replica",
        health: values.health,
        utilization: clamp(values.share),
        sublabel: `${formatCount(remoteReadRate)} queries/s · cross-AZ`,
        detail:
          "This reader is in another AZ. It may be closer to the writer or cheaper to place, but every response travels across a zone boundary.",
        meta: { view: "flow" },
      },
      {
        id: "writer",
        label: "Writer · us-east-1b",
        kind: "db",
        role: "primary",
        health: values.health,
        sublabel: "writes · cross-AZ for app",
        detail:
          "Writes go to the single writer. If the application is in another AZ, commit traffic and replication traffic both cross boundaries.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-local", "app", "reader-local", clamp(localReadRate / 5_000), "ok", "local"),
      edge("app-remote", "app", "reader-remote", clamp(remoteReadRate / 5_000), values.health, "cross-AZ"),
      edge("app-writer", "app", "writer", clamp(values.requestRate / 5_000), values.health, "writes"),
    ],
    metrics: [
      metric("cross-az-cost", "Monthly cross-AZ cost", values.monthlyCost, " $", 400, 1_500, "number"),
      metric("added-latency", "Added p99 latency", values.addedLatencyMs, " ms", 2, 5, "ms"),
      metric("cross-az-transfer", "Cross-AZ transfer", values.transferGbMonth, " GB", undefined, undefined, "number"),
      metric("cross-az-share", "Reads leaving the AZ", values.share * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.requestRate)} req/s × ${values.queriesPerRequest} queries; ${Math.round(
      values.share * 100,
    )}% of reads cross an AZ; ${formatGb(values.transferGbMonth)}/month; $${formatCount(
      values.monthlyCost,
    )}/month illustrative.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cross-az-cost",
    metricId: "cross-az-cost",
    warn: 400,
    crit: 1_500,
    title: "Cross-AZ data transfer dominates the database bill",
    cause:
      "Every query and response that crosses a zone boundary is billed, and a chatty request multiplies the number of round trips. Retries add traffic without adding successful work.",
    fix:
      "Place readers in the application's AZ, reduce round trips with batching or joins, and trim response size. Keep cross-AZ reads for workloads that need them.",
    checkFirst: [
      "Attribute transfer to a call path, not just to the database as a whole.",
      "Compare queries per request with the number of useful rows returned.",
      "Check retry rates and connection-pool churn for extra round trips.",
    ],
  },
  {
    id: "added-latency",
    metricId: "added-latency",
    warn: 2,
    crit: 5,
    title: "Cross-AZ round trips are adding latency",
    cause:
      "Each cross-AZ query pays a network round trip. A request that issues many small queries pays that cost repeatedly, and p99 inherits the worst sequence.",
    fix:
      "Pin reads to a local reader, batch or join queries, and cache stable data. Moving the reader is cheaper than making every request cross the boundary.",
    checkFirst: [
      "Count database round trips per request in a trace.",
      "Compare local and cross-AZ reader latency for the same query.",
      "Check whether the ORM is issuing per-row queries.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const costModel: SimModel = {
  id: "databases-cross-az-cost",
  visual: "flow",
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
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.monthlyCost >= 1_500 && frame.flags.costLogged !== 1) {
      pushEvent(next, {
        id: "cross-az-cost-spike",
        at: frame.t,
        severity: "crit",
        title: "Cross-AZ transfer is the top cost line",
        detail: `${formatGb(values.transferGbMonth)} per month crosses zones at ${Math.round(
          values.share * 100,
        )}% of reads and ${values.queriesPerRequest} queries per request.`,
        nodeId: "reader-remote",
        metricId: "cross-az-cost",
      });
    }
    next.flags.costLogged = values.monthlyCost >= 1_500 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The application issues ${formatCount(values.requestRate * values.queriesPerRequest)} queries per second; ${Math.round(
        values.share * 100,
      )}% of reads cross an AZ, or ${formatCount(values.crossAzQueriesPerSecond)} queries per second.`,
      `At ${values.responseKb.toFixed(0)} KB per response plus request overhead, that is about ${formatGb(
        values.transferGbMonth,
      )} per month and about $${formatCount(values.monthlyCost)} at an illustrative $0.01 per GB in each direction.`,
      `Added p99 latency is about ${values.addedLatencyMs.toFixed(
        2,
      )} ms: queries per request times the share that crosses times a sub-millisecond hop. Chatty requests multiply it.`,
      "The bill grows with round trips and payload, not only with request rate. Halving queries per request can halve transfer while serving the same users.",
      "Sending every read to the writer avoids the reader hop but concentrates load and may still cross an AZ. Placement, not just routing, decides the cost.",
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
    description: "Most reads stay in the application's AZ, with four queries per request and small responses.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Twice the requests, half the reads crossing, and larger responses push cost and latency into warning.",
    tone: "warn",
    params: defaults({ requestsPerSecond: 800, queriesPerRequest: 8, crossAzShare: 50, responseKb: 4 }),
  },
  {
    id: "failure",
    label: "Chatty cross-AZ",
    description: "High traffic, 20 queries per request, and 90% of reads leaving the AZ produce a five-figure monthly transfer bill.",
    tone: "crit",
    params: defaults({ requestsPerSecond: 2_000, queriesPerRequest: 20, crossAzShare: 90, responseKb: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Reads are pinned locally and the request is batched down to four queries with a 2 KB response.",
    tone: "ok",
    params: defaults({ requestsPerSecond: 800, queriesPerRequest: 4, crossAzShare: 10, responseKb: 2 }),
  },
];

const experiment: Experiment = {
  id: "bill-grows-faster",
  title: "Why the transfer bill outgrows request volume",
  simId: "cross-az-cost",
  question:
    "Request volume grew 40%, but the cross-AZ transfer line grew more than 200%. Which change explains the gap?",
  prediction: {
    options: [
      { id: "storage", label: "The database stored more rows, so backups grew." },
      { id: "round-trips", label: "Each request started making more cross-AZ round trips with larger responses." },
      { id: "replicas", label: "A new read replica was added in the same AZ." },
      { id: "cpu", label: "The writer's CPU utilization rose, so queries took longer." },
    ],
    correctOptionId: "round-trips",
    explanation:
      "Cross-AZ transfer is billed per byte and per direction, so it scales with round trips and payload, not just with requests. An ORM change that turns one query into five, or a response that grows from 2 KB to 8 KB, multiplies the bill even when user traffic grows modestly. Storage and same-AZ replicas are different cost lines, and CPU does not directly add transfer.",
  },
  setup: defaults({ requestsPerSecond: 800, queriesPerRequest: 20, crossAzShare: 80, responseKb: 8 }),
  runFor: 20,
  observe: [
    "Cross-AZ queries per second rise from about 320 to 12,800.",
    "Monthly transfer reaches hundreds of terabytes and the cost threshold goes critical.",
    "Added p99 latency rises to nearly 10 ms from the repeated hops.",
    "Request rate alone did not explain the bill; queries per request and response size did.",
  ],
  explain:
    "The cost formula is request rate × queries per request × cross-AZ share × bytes per query. Each factor can change independently. A chatty ORM change is a cost incident even when traffic is flat, and a payload change can double transfer without changing query count. Attribute the bill to a call path before optimizing the database.",
  fix: defaults({ requestsPerSecond: 800, queriesPerRequest: 4, crossAzShare: 10, responseKb: 2 }),
  debrief:
    "Batching to four queries and pinning 90% of reads locally cuts cross-AZ transfer by roughly two orders of magnitude in this model. The remaining $47 per month is mostly writes and the reads that genuinely need the remote reader. The tradeoff is that the local reader must be sized and kept current.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cross-AZ traffic is network traffic between Availability Zones in the same Region. It is usually billed per gigabyte in each direction, and it adds a network round trip to every database call that leaves the zone. The charge is small per query and large at scale, especially when an application makes many small queries.",
  },
  {
    type: "p",
    text: "The cost is multiplicative: request rate times queries per request times the share of queries that cross a boundary times bytes per query. A change to any factor moves the bill. That is why a 40% traffic increase can produce a 200% transfer increase if the application also became chattier or started returning wider rows.",
  },
  {
    type: "p",
    text: "Latency has the same shape. One cross-AZ round trip is fractions of a millisecond. Twenty of them inside one request are milliseconds, and the p99 request inherits the worst sequence. Batching and local placement reduce both the bill and the tail.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application task runs in an AZ. A local reader is in the same AZ; a remote reader and the writer may be in another. The reader endpoint spreads connections across readers, but it does not know which AZ the client is in, so it can hand a connection to a reader across the boundary. Writes always go to the single writer, which may itself be remote.",
  },
  {
    type: "table",
    headers: ["Path", "Crosses an AZ?", "What drives the bytes"],
    rows: [
      ["App to local reader", "No", "Query count and response size"],
      ["App to remote reader", "Yes", "Same, billed in both directions"],
      ["App to writer (writes)", "Usually", "Commit traffic, not just rows"],
      ["Reader to writer replication", "Yes", "Write volume and replication overhead"],
      ["Backups and snapshots", "No (storage service)", "Stored data and retention"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Monthly cross-AZ cost: warning at $400 and critical at $1,500 in this illustrative model.",
      "Added p99 latency: warning at 2 ms and critical at 5 ms from repeated cross-AZ round trips.",
      "Cross-AZ transfer in GB per month, separate from storage and backup cost.",
      "Reader placement cards: local versus remote readers with their query rates.",
      "A queries-per-request slider, which changes cost and latency without changing user traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Chatty cross-AZ. Read cost and added latency before changing anything. Lower queries per request and the cross-AZ share separately to see which factor dominates. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Prices, payload sizes, and thresholds are illustrative teaching values. Real transfer pricing varies by Region, direction, and service; check the current pricing page for the Region you operate in.",
  },
  { type: "sim", simId: "cross-az-cost" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 2,000 requests per second with 20 queries each and 90% of reads leaving the AZ, the application issued 36,000 cross-AZ queries per second. With 9 KB per query in both directions, the modeled transfer reached hundreds of terabytes per month and the cost line crossed critical while the request rate alone looked like a normal peak.",
  },
  {
    type: "p",
    text: "Batching to four queries and pinning 90% of reads locally cut cross-AZ queries per second to 320 at the same request rate. Cost fell to about $47 per month and added latency to a fraction of a millisecond. The database did not get faster or cheaper by itself; the application changed how often it crossed the boundary.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cost Explorer and the Cost and Usage Report, filtered by data transfer and by AZ, compared with request volume.",
      "Aurora and RDS reader endpoints and reader placement, plus which reader each application task connects to.",
      "Query counts per request and per endpoint from application tracing or pg_stat_statements, including N+1 patterns.",
      "Response size and rows returned per query, which drive the response direction of transfer.",
      "Retry and reconnect rates: retries add round trips without adding successful requests.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Attribute the transfer to one call path. Compare queries per request, response size, and the share of reads crossing an AZ. If the bill grew faster than traffic, look for a chatty ORM change, a wider SELECT, or a retry loop before changing database capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Break down transfer by AZ, endpoint, and call path; do not optimize the database total.",
      "Reduce round trips with joins, batching, or a dataloader for per-row queries.",
      "Trim response size with projection, pagination, and compression where the client supports it.",
      "Place readers in the AZs where the application runs and route reads locally.",
      "Keep cross-AZ reads for failover, capacity, or consistency needs that justify the cost.",
      "Fix retry storms and connection churn, which add traffic without useful work.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Local readers reduce transfer but add replicas and replication traffic, and they may be smaller or staler.",
      "Sending reads to the writer avoids reader hops but concentrates load and can still cross an AZ.",
      "Compression reduces bytes but costs CPU and can increase latency for small responses.",
      "Batching reduces round trips but increases query complexity and can make one slow query block more work.",
      "Cross-AZ placement improves failover options; eliminating all cross-AZ traffic can make recovery harder.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-source",
    question: "The cross-AZ transfer line tripled while request volume stayed flat. How do you find the source?",
    difficulty: 3,
    hints: [
      "Break it down by call path, not by database total.",
      "Look for changes in round trips or payload.",
    ],
    answer:
      "I would break the cost down by AZ pair, endpoint, and application call path, then compare queries per request, response size, and retry rate with the previous period. Flat request volume with rising transfer usually means more round trips per request, a wider response, a retry loop, or a routing change that sends reads to a remote reader. I would confirm with traces and pg_stat_statements, then fix the call path rather than resizing the database.",
    followUps: [
      "Which change is cheapest to test first?",
      "How would a reader endpoint change affect this?",
      "What would you measure after the fix?",
    ],
    redFlags: [
      "Blames storage or backups without checking.",
      "Resizes the database first.",
      "Ignores routing changes.",
    ],
    rubric: [
      "Attributes cost to a call path.",
      "Checks round trips and payload.",
      "Considers retries and routing.",
      "Verifies after the fix.",
    ],
  },
  {
    id: "placement",
    question: "How do you decide where to place read replicas?",
    difficulty: 3,
    hints: [
      "Start from where the clients run.",
      "Balance transfer, latency, and failover.",
    ],
    answer:
      "I would place replicas in the AZs with the most read traffic so most queries stay local, then keep at least one replica outside the writer's AZ for failover and load. I would compare the transfer saved with the cost of the extra replica and its replication traffic, and check whether the local replica can serve the query shapes and freshness the product needs. Placement is a routing and capacity decision, not just a cost decision.",
    followUps: [
      "What if traffic is evenly split across three AZs?",
      "How does read-after-write affect placement?",
      "When would a cross-AZ read be correct?",
    ],
    redFlags: [
      "Places all replicas with the writer.",
      "Ignores failover.",
      "Optimizes cost without freshness.",
    ],
    rubric: [
      "Starts from client placement.",
      "Balances cost and failover.",
      "Checks freshness.",
      "Routes reads deliberately.",
    ],
  },
  {
    id: "quantify",
    question: "Estimate the monthly cross-AZ cost of one chatty endpoint.",
    difficulty: 2,
    hints: [
      "Requests × queries × share × bytes.",
      "Transfer is billed in both directions.",
    ],
    answer:
      "I would multiply request rate by queries per request by the share that crosses an AZ to get cross-AZ queries per second. Then I would multiply by bytes per query in both directions, convert to gigabytes per month, and apply the per-GB price for that Region. The point of the estimate is to rank call paths, not to predict the invoice to the dollar, because retries, connection overhead, and pricing details add variance.",
    followUps: [
      "Which term is usually easiest to reduce?",
      "How would retries enter the estimate?",
      "Why is the direction count important?",
    ],
    redFlags: [
      "Uses request rate alone.",
      "Forgets the response direction.",
      "Ignores queries per request.",
    ],
    rubric: [
      "Uses all four factors.",
      "Counts both directions.",
      "Converts time units correctly.",
      "Treats the estimate as a ranking tool.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Cost is attributed by AZ pair, endpoint, and application call path.",
      "Reader placement follows the AZs where application tasks run.",
      "Queries per request and response size are tracked for top endpoints.",
      "Retry and reconnect rates are monitored as extra traffic.",
      "A cost anomaly alert compares transfer with request volume.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the call path whose round trips or payload changed.",
      "Check whether routing moved reads to a remote reader.",
      "Check retries and connection churn before blaming the database.",
      "Reduce the dominant factor rather than resizing everything.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the transfer and latency change with the same breakdown.",
      "Update query patterns, reader routing, and payload limits.",
      "Record the cost per request for the endpoint.",
      "Re-check failover placement after moving readers.",
    ],
  },
];

const references = [
  {
    title: "Amazon Aurora reader endpoints",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.Endpoints.Reader.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How the reader endpoint distributes connections across Aurora Replicas and why client AZ placement still matters.",
  },
  {
    title: "Amazon RDS for PostgreSQL read replicas",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Read replica placement, replication, and promotion behavior.",
  },
  {
    title: "AWS data transfer pricing",
    url: "https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Regional and cross-AZ data transfer pricing; verify current rates for your Region.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cross-az-cost": {
      model: costModel,
      presets,
      instructions:
        "Start healthy, apply Chatty cross-AZ, and read cost and latency before changing a slider. Lower queries per request and the cross-AZ share separately to see which factor dominates. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Transfer price, payload sizes, and thresholds are teaching values; check current AWS pricing for real costs.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-multi-az-vs-region",
    "databases-read-replica-routing",
    "databases-n-plus-one",
    "databases-rds-aurora-arch",
    "observability-telemetry-cost",
  ],
};
