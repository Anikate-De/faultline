import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BYTES_PER_LINE = 600;
const SECONDS_PER_DAY = 86_400;

const params = [
  {
    id: "taskCount",
    label: "Service tasks",
    min: 4,
    max: 200,
    step: 4,
    value: 20,
    unit: " tasks",
    group: "Fleet",
    help: "Tasks that emit application logs for the same request. A request touches many of them.",
    format: "count" as const,
  },
  {
    id: "linesPerTask",
    label: "Lines per task",
    min: 1,
    max: 200,
    step: 1,
    value: 20,
    unit: " lines/s",
    group: "Volume",
    help: "Log lines per second from each task. Volume affects search cost but not whether a request can be joined.",
    format: "number" as const,
  },
  {
    id: "structuredShare",
    label: "Structured field coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Schema",
    help: "Share of lines emitted as key-value fields with a stable event name instead of prose.",
    format: "percent" as const,
  },
  {
    id: "correlationCoverage",
    label: "Request ID coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 98,
    unit: "%",
    group: "Schema",
    help: "Share of lines carrying the request ID or trace ID that ties the request together across tasks.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tasks: number;
  lines: number;
  structured: number;
  correlation: number;
  volumeLines: number;
  volumeGb: number;
  querySuccess: number;
  shortfall: number;
  unmatched: number;
  searchP95: number;
}

function compute(p: Params): Computed {
  const tasks = Math.round(num(p, "taskCount", 20));
  const lines = Math.round(num(p, "linesPerTask", 20));
  const structured = num(p, "structuredShare", 100);
  const correlation = num(p, "correlationCoverage", 98);
  const volumeLines = tasks * lines;
  const volumeGb = (volumeLines * SECONDS_PER_DAY * BYTES_PER_LINE) / 1_000_000_000;
  const querySuccess = clamp(6 + 0.55 * structured + 0.45 * correlation, 0, 100);
  const shortfall = 100 - querySuccess;
  const unmatched = 1000 * (1 - correlation / 100);
  const searchP95 = 1 + 900 / Math.max(8, querySuccess) + volumeGb / 150;
  return {
    tasks,
    lines,
    structured,
    correlation,
    volumeLines,
    volumeGb,
    querySuccess,
    shortfall,
    unmatched,
    searchP95,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const volumeHealth = healthFor(values.volumeGb, 60, 120);
  const searchHealth = healthFor(values.shortfall, 30, 60);
  return {
    t: 0,
    nodes: [
      {
        id: "tasks",
        label: `${values.tasks} service tasks`,
        kind: "service",
        health: "ok",
        utilization: clamp(values.tasks / 200),
        sublabel: `serving · ${values.correlation.toFixed(0)}% carry a request ID`,
      },
      {
        id: "agent",
        label: "Log agent",
        kind: "worker",
        health: volumeHealth,
        utilization: clamp(values.volumeGb / 120),
        sublabel: `${values.volumeGb.toFixed(0)} GB/day`,
      },
      {
        id: "pipeline",
        label: "Log pipeline",
        kind: "service",
        health: volumeHealth,
        utilization: clamp(values.volumeGb / 140),
        sublabel: "parse, route, index",
      },
      {
        id: "index",
        label: "Log index",
        kind: "storage",
        health: volumeHealth,
        utilization: clamp(values.volumeGb / 180),
        sublabel: "searchable fields",
      },
      {
        id: "search",
        label: "Search and correlate",
        kind: "external",
        health: searchHealth,
        utilization: values.shortfall / 100,
        sublabel: `p95 ${values.searchP95.toFixed(0)}s`,
      },
    ],
    edges: [
      edge("tasks-agent", "tasks", "agent", clamp(values.volumeGb / 120), volumeHealth),
      edge("agent-pipeline", "agent", "pipeline", clamp(values.volumeGb / 140), volumeHealth),
      edge("pipeline-index", "pipeline", "index", clamp(values.volumeGb / 180), volumeHealth),
      edge("index-search", "index", "search", clamp(values.querySuccess / 100), searchHealth),
    ],
    metrics: [
      metric("query-shortfall", "Query reconstruction shortfall", values.shortfall, "%", 30, 60, "percent"),
      metric("unmatched-lines", "Lines without a request ID", values.unmatched, " /1k", 100, 500, "count"),
      metric("query-p95", "Search p95", values.searchP95, "s", 25, 60, "number"),
      metric("log-volume", "Log volume", values.volumeGb, " GB/day", 60, 120, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.shortfall.toFixed(0)}% of the request narrative is missing; ${values.unmatched.toFixed(0)} lines per 1,000 lack a request ID; search p95 ${values.searchP95.toFixed(0)}s at ${values.volumeGb.toFixed(0)} GB/day.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-shortfall",
    metricId: "query-shortfall",
    warn: 30,
    crit: 60,
    title: "The request cannot be reconstructed from logs",
    cause: "Lines are missing stable fields or the request ID that joins tasks, so a search returns fragments rather than one request narrative.",
    fix: "Emit one structured event per meaningful step with a request ID, service, event name, outcome, and duration. Fix the emit path, not the search query.",
    checkFirst: [
      "Count lines for one known request ID across every task.",
      "Check whether the missing lines share a service, task revision, or log level.",
      "Compare the deployed logger configuration with the schema in the repository.",
    ],
  },
  {
    id: "unmatched-lines",
    metricId: "unmatched-lines",
    warn: 100,
    crit: 500,
    title: "A large share of lines cannot be joined",
    cause: "The request ID is generated inside one task, added only to access logs, or dropped by a background worker that starts a new context.",
    fix: "Generate or accept the request ID at the edge, propagate it through every call and queue message, and attach it in the logger middleware.",
    checkFirst: [
      "Sample lines from the task with the highest unmatched count.",
      "Check async boundaries: queues, cron jobs, and thread pools.",
      "Verify the logger binds context before the first line is emitted.",
    ],
  },
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 25,
    crit: 60,
    title: "Search latency makes the logs useless during an incident",
    cause: "Unstructured text and missing indexed fields force a scan of every line, and volume multiplies the work.",
    fix: "Index the fields used in incident queries, keep event names stable, and move high-cardinality values such as user IDs out of indexed fields.",
    checkFirst: [
      "Inspect the query plan or the fields the query actually filters.",
      "Check whether a wildcard search is scanning the full retention window.",
      "Compare p95 for a field query with p95 for a free-text search.",
    ],
  },
  {
    id: "log-volume",
    metricId: "log-volume",
    warn: 60,
    crit: 120,
    title: "Log volume is approaching the pipeline budget",
    cause: "Per-request logging multiplies with traffic, and verbose levels add lines that no incident query uses.",
    fix: "Set levels per event, sample high-volume debug lines, and route audit or error events separately from chatty request logs.",
    checkFirst: [
      "Rank services by bytes per request, not total bytes.",
      "Check the level distribution for the noisiest event names.",
      "Confirm retention is applied to the index that receives the volume.",
    ],
  },
];

export const structuredLoggingModel: SimModel = {
  id: "observability-structured-logging",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p95" ? { ...item, value: item.value * jitter } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.shortfall >= 60 && frame.flags.joinFailure !== 1) {
      pushEvent(next, {
        id: "request-not-reconstructable",
        at: frame.t,
        severity: "crit",
        title: "Request narrative is incomplete",
        detail: `${values.shortfall.toFixed(0)}% of the expected request context cannot be reconstructed. ${values.unmatched.toFixed(0)} of every 1,000 lines have no request ID.`,
        nodeId: "search",
        metricId: "query-shortfall",
      });
      next.flags.joinFailure = 1;
    }
    if (values.shortfall < 60) next.flags.joinFailure = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.shortfall.toFixed(0)}% of the request narrative is missing; ${values.unmatched.toFixed(0)} lines per 1,000 lack a request ID; search p95 ${values.searchP95.toFixed(0)}s at ${values.volumeGb.toFixed(0)} GB/day.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.correlation < 100) {
      items.push(`At ${values.correlation.toFixed(0)}% request ID coverage, every 1,000 lines leave ${values.unmatched.toFixed(0)} without a join key.`);
    } else {
      items.push("Every line carries the request ID, so the 20-task path can be sorted into one narrative.");
    }
    items.push(`Structured fields explain part of query success, but the join key is what connects tasks. Current reconstruction shortfall is ${values.shortfall.toFixed(0)}%.`);
    items.push(`Search p95 is ${values.searchP95.toFixed(0)}s. Free-text scans grow with volume; field queries grow with the number of matching lines.`);
    items.push(`The pipeline receives ${values.volumeGb.toFixed(0)} GB/day from ${values.tasks} tasks at ${values.lines} lines per second each.`);
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Structured events with request IDs on 98% of lines at a modest volume.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Twice the tasks and higher volume. Some prose remains and request IDs cover 60%.",
    tone: "warn",
    params: defaults({ taskCount: 40, linesPerTask: 30, structuredShare: 80, correlationCoverage: 60 }),
  },
  {
    id: "failure",
    label: "Unstructured logs",
    description: "Prose lines from 20 tasks, almost none carrying a request ID. The request cannot be joined.",
    tone: "crit",
    params: defaults({ structuredShare: 15, correlationCoverage: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Structured events and full request ID propagation. Search returns one request narrative.",
    tone: "ok",
    params: defaults({ structuredShare: 100, correlationCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-log-join",
  title: "Predict what JSON alone buys you",
  simId: "structured-logging",
  question:
    "The team converts every log line to JSON but does not add a request ID. Can you still collect all lines for one request across 20 tasks?",
  prediction: {
    options: [
      { id: "works", label: "Yes. JSON fields are enough to filter by service and timestamp" },
      { id: "partial", label: "No. You can filter by field, but you cannot prove which lines belong to the same request" },
      { id: "volume", label: "Yes, but only if log volume stays under the index budget" },
      { id: "rejected", label: "No. The pipeline rejects JSON without a trace ID" },
    ],
    correctOptionId: "partial",
    explanation:
      "JSON gives the query fields to filter on. Correlation needs a value that every task receives and writes: the request ID, or the trace ID that contains it. Without that key, two lines from the same millisecond and service are indistinguishable from lines belonging to two different requests.",
  },
  setup: defaults({ structuredShare: 100, correlationCoverage: 0 }),
  runFor: 20,
  observe: [
    "Structured field coverage is 100%, yet the reconstruction shortfall is 39%.",
    "All 1,000 sampled lines lack a request ID, crossing the critical threshold.",
    "Search p95 rises as the query scans more matching lines, but the missing join key is the real blocker.",
    "The application tasks stay healthy; the failure is in the telemetry query path, not in request handling.",
  ],
  explain:
    "A log schema has two jobs. Fields make a line machine-readable; a correlation key makes a set of lines a request. The key must be created at the edge, propagated through HTTP and queue boundaries, and bound into the logger before the first event. Formatting alone changes how a line is stored, not how it is joined.",
  fix: defaults({ structuredShare: 100, correlationCoverage: 100 }),
  debrief:
    "With full coverage the same volume becomes a single request narrative: filter on the request ID, then sort by timestamp. The schema still needs stable event names and bounded field values, or the next incident will trade a join problem for a query-cost problem. Keep the request ID out of metrics and high-cardinality indexes.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A structured log line is a record with named fields, not a sentence. Instead of `checkout failed for order 8123 after 2400ms`, the emitter writes `event=checkout.failed`, `order_id=8123`, `duration_ms=2400`, `request_id=...`, `service=checkout`, and `level=error`. The fields have stable names, types, and meanings, so a query can filter and aggregate them without parsing prose.",
  },
  {
    type: "p",
    text: "The harder requirement is correlation. One request crosses a load balancer, several services, a queue, and a database. Each task writes its own lines. A request ID created at the edge and carried through every hop turns those lines into one narrative. A trace ID can serve the same purpose when tracing is enabled. JSON without a join key is still a pile of separate records.",
  },
  {
    type: "p",
    text: "Log levels are part of the schema, not decoration. `error` should mean a request or operation failed, `warn` should mean a degraded path that succeeded, and `info` should mark a completed unit of work. Debug lines are for development and are usually sampled or dropped in production. If every event is `info`, the level cannot be used to reduce volume or route alerts.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application task, log agent, pipeline, index, then query. The logger runs inside the task and should bind request context before the first line. The agent ships bytes, the pipeline parses and routes them, and the index stores the fields that queries use. A field that is dropped at the pipeline cannot be recovered at query time.",
  },
  {
    type: "table",
    headers: ["Layer", "What it decides", "Common failure"],
    rows: [
      ["Task and logger", "Fields, level, event name, request ID", "Context generated too late or only in the HTTP middleware"],
      ["Agent", "Batching, retries, local buffering", "Blocking the application or dropping lines silently"],
      ["Pipeline", "Parsing, field extraction, routing", "Parser rejects a new format; fields never reach the index"],
      ["Index and query", "Which fields are searchable and how long", "Free-text scans, missing join key, retention too short"],
    ],
  },
  {
    type: "p",
    text: "The model here uses illustrative values: 20 tasks, 20 lines per second per task, 600 bytes per line, and a query-success curve. They are teaching values, not a vendor limit. The shape of the failure is what matters: a missing join key cannot be fixed by a faster search engine, and volume cannot be fixed by a better schema alone.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Query reconstruction shortfall: the share of request context the logs cannot supply.",
      "Lines without a request ID per 1,000: the direct measure of join coverage.",
      "Search p95: how long a query takes when it must scan text or many matching lines.",
      "Log volume in GB per day: the cost and pipeline pressure created by per-request lines.",
      "Node health along the path, so a schema problem is visible as a failing search node while tasks keep serving.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Unstructured logs. Watch the request ID metric and the search node together. Run the guided experiment before reading the debrief: predict whether JSON alone can join a request, then apply the correlation fix and compare the same volume.",
  },
  {
    type: "compare",
    leftTitle: "Prose logs",
    rightTitle: "Structured logs with a request ID",
    rows: [
      { label: "Human reading", left: "Fast for one line", right: "Slower without a viewer" },
      { label: "Field query", left: "Regex over every line", right: "Indexed field filter" },
      { label: "Cross-task join", left: "Timestamp guessing", right: "Request ID exact match" },
      { label: "Level filtering", left: "Prefix convention", right: "Typed level field" },
      { label: "Schema change", left: "Breaks parsers quietly", right: "Versioned event contract" },
    ],
  },
  { type: "sim", simId: "structured-logging" },
  { type: "experiment", experimentId: "predict-log-join" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset removed the field that made the lines a request. Each task still logged, and the volume stayed the same, but the search could not prove which lines belonged together. The shortfall metric rose because the query had to guess from timestamps and service names. The application tasks kept serving traffic while the search node failed, which is exactly how this incident looks from the outside.",
  },
  {
    type: "p",
    text: "The recovery preset restored structured coverage and request ID propagation. The same lines became filterable and joinable, so search p95 fell and the shortfall returned to zero. The schema did not reduce volume; it made the volume answer a question. Volume control is a separate lever, covered in the log volume and cost module.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch Logs Insights: a query for one request ID returns lines from every task; a query by timestamp alone returns too many neighbors.",
      "OpenSearch or Elasticsearch: the mapping shows whether `request_id` is a keyword field, and the query plan shows a full scan when it is not.",
      "Loki: label and structured metadata choices decide whether the request ID is indexed or only searchable in the line.",
      "Datadog or Splunk: the log explorer shows the field coverage and the percentage of events missing the correlation attribute.",
      "Application logs: the logger line that binds context, and the async boundary where the context is lost.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Pick one failing request and count its lines in every task. If the count is fragmented, check request ID propagation before touching the search cluster. If the lines are present but the fields are missing, check the logger schema and the pipeline parser.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define one event contract per meaningful step: event name, level, service, request ID, outcome, duration, and a small set of bounded attributes.",
      "Create or accept the request ID at the edge and propagate it through HTTP headers, queue messages, and background job payloads.",
      "Bind the context in the logger middleware before the first line, and test an async path end to end.",
      "Index only the fields incident queries use; keep high-cardinality identifiers in the line or in traces.",
      "Set levels by event, sample debug lines, and route audit events separately.",
      "Verify with a real request: one query, every task, one ordered timeline.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More fields improve queries but increase bytes per line and the chance of leaking sensitive values; redaction belongs at emit time.",
      "Request IDs are high-cardinality. Keep them in logs and traces, not in metric labels or low-cardinality indexes.",
      "Stable event names make dashboards and alerts possible, but renaming an event is a schema change that needs a transition period.",
      "Sampling debug lines cuts volume and can remove the one line that explains a rare failure; sample by event and keep errors unsampled.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "schema-fields",
    question:
      "You need every log line for one request across 20 tasks. Which fields must the schema contain, and which are optional?",
    difficulty: 2,
    hints: [
      "Separate the join key from the descriptive fields.",
      "Think about what changes between tasks and what must stay stable.",
    ],
    answer:
      "The required fields are a request ID or trace ID that every task receives, a timestamp with a known clock source, the service and task identity, a stable event name, the level, and the outcome. Duration and a small set of bounded attributes make the line useful, but they are optional per event. High-cardinality values such as user ID or order ID belong in the line or a trace, not in indexed metric labels. I would also include a schema version so parsers can evolve without silently dropping fields.",
    followUps: [
      "How do you handle a request that fans out to a queue consumer?",
      "Where would you put the request ID if the client does not send one?",
      "What would you exclude from the indexed fields?",
    ],
    redFlags: [
      "Lists only JSON formatting.",
      "Puts user IDs in metric labels.",
      "Has no plan for async boundaries.",
    ],
    rubric: [
      "Names a correlation key and propagation path.",
      "Separates required from optional fields.",
      "Considers async and schema evolution.",
      "Mentions cardinality or PII risk.",
    ],
  },
  {
    id: "json-not-enough",
    question:
      "A team converts all logs to JSON and the incident query still cannot reconstruct a request. What do you check?",
    difficulty: 2,
    hints: [
      "Formatting changes storage, not identity.",
      "Find where the request context is created and where it is lost.",
    ],
    answer:
      "I would check whether the request ID is present on the lines, not just whether the line is JSON. I would pick one request, count its lines in each task, and find the first task where the ID disappears. Common causes are a logger that binds context only in the HTTP middleware, a queue consumer that starts a new context, or a pipeline parser that drops unknown fields. I would also check that the ID field is indexed as a keyword and that the query is not scanning a different retention window.",
    followUps: [
      "How would you test the async path before the next incident?",
      "What if the ID is present but duplicated across retries?",
      "Which signal tells you the problem is at emit time rather than query time?",
    ],
    redFlags: [
      "Blames the search cluster first.",
      "Adds more fields without checking propagation.",
      "Ignores queue consumers.",
    ],
    rubric: [
      "Checks presence and propagation of the join key.",
      "Separates emit-time from query-time causes.",
      "Names a concrete test.",
    ],
  },
  {
    id: "levels",
    question:
      "How do you decide whether an event is info, warn, or error, and why does the distinction matter for cost?",
    difficulty: 1,
    hints: [
      "Define each level by the outcome, not by how the developer feels.",
      "Levels drive routing, sampling, and alerting.",
    ],
    answer:
      "I define levels by outcome. Error means the operation failed or the user received a failure. Warn means the operation succeeded through a degraded path that needs attention. Info marks a completed unit of work, such as an order accepted. Debug is for development detail and is sampled or dropped in production. The distinction matters because routing, retention, and sampling key off the level; if everything is info, the team pays to store noise and cannot isolate errors.",
    followUps: [
      "Should a retry that eventually succeeds be warn or info?",
      "How do you keep error logs unsampled under volume?",
      "What happens when a library logs at error for a handled condition?",
    ],
    redFlags: [
      "Treats level as a severity preference.",
      "Logs every exception at error regardless of handling.",
      "Has no routing or sampling policy.",
    ],
    rubric: [
      "Defines levels by outcome.",
      "Connects levels to routing and cost.",
      "Handles handled exceptions and retries.",
    ],
  },
  {
    id: "schema-governance",
    question:
      "How do you keep a log schema stable when 20 teams own the emitters?",
    difficulty: 3,
    hints: [
      "Make the contract explicit and testable.",
      "Version changes and measure adoption.",
    ],
    answer:
      "I would publish a small event contract with required fields, allowed levels, and naming rules, then enforce it in the shared logger library and in CI. The library binds request context and emits the envelope; teams own the event name and a bounded attribute set. I would version the schema, run a parser compatibility test in staging, and measure field coverage by service. Renames get a dual-write period. The tradeoff is central review and a shared dependency, but it prevents twenty incompatible formats from reaching the index.",
    followUps: [
      "Where do you draw the line between a shared envelope and team-specific fields?",
      "How do you migrate an event name without breaking dashboards?",
      "What metric would you use to track schema adoption?",
    ],
    redFlags: [
      "Lets every team choose its own format.",
      "Breaks event names without a transition.",
      "Has no CI check or ownership.",
    ],
    rubric: [
      "Defines a shared envelope and local attributes.",
      "Versions and tests the contract.",
      "Measures adoption and handles migration.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every request gets a request ID at the edge and carries it through HTTP and queue boundaries.",
      "The logger binds request context before the first line in HTTP, worker, and cron paths.",
      "Event names and required fields are documented and tested in CI.",
      "Incident queries use indexed fields; free-text search is a fallback, not the primary path.",
      "Retention covers the longest realistic investigation window.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Pick one failing request and count its lines across every task.",
      "Find the first hop where the request ID or structured field disappears.",
      "Check the pipeline parser before changing the application logger.",
      "Avoid widening the retention window as a first response; it adds cost without adding a join key.",
      "Record the query and the missing field for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test that emits through an async boundary and asserts the join key.",
      "Measure field coverage by service and alert on a drop after a deploy.",
      "Remove temporary verbose logging and reconcile sampled debug events.",
      "Review retention and index cost against the queries responders actually ran.",
    ],
  },
];

const references = [
  {
    title: "Logs Data Model",
    url: "https://opentelemetry.io/docs/specs/otel/logs/data-model/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Field conventions, severity, body, attributes, and trace correlation.",
  },
  {
    title: "Logs",
    url: "https://opentelemetry.io/docs/concepts/signals/logs/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "How logs relate to traces and metrics, and why correlation identifiers matter.",
  },
  {
    title: "Effective Troubleshooting",
    url: "https://sre.google/sre-book/effective-troubleshooting/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Using logs and traces to test hypotheses during an incident.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "structured-logging": {
      model: structuredLoggingModel,
      presets,
      instructions:
        "Start Healthy, then apply Unstructured logs. Compare the request ID metric with search latency, then run the guided experiment and apply the correlation fix.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Byte size, query-success curve, and volume thresholds are teaching values, not vendor limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-pii-redaction",
    "observability-distributed-tracing",
    "observability-log-volume-cost",
    "observability-error-grouping",
  ],
};
