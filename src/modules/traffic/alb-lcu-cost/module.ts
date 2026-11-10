import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NEW_CONNECTIONS_PER_LCU = 25;
const ACTIVE_CONNECTIONS_PER_LCU = 3_000;
const GB_PER_LCU_HOUR = 1;
const RULE_EVALUATIONS_PER_LCU = 1_000;
const FREE_RULES = 10;
const ILLUSTRATIVE_PLAN_LCU = 500;
const TOTAL_RPS = 20_000;
const REQUEST_BYTES_KB = 1;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 100_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second. At a fixed response size, more requests means more processed bytes and more new connections.",
    format: "rps" as const,
  },
  {
    id: "requestsPerConnection",
    label: "Requests per connection",
    min: 1,
    max: 100,
    step: 1,
    value: 20,
    unit: " req",
    group: "Connection shape",
    help: "Requests sent on one TCP connection. Higher reuse reduces new connections per second for the same request rate.",
    format: "count" as const,
  },
  {
    id: "connectionSeconds",
    label: "Connection lifetime",
    min: 10,
    max: 600,
    step: 10,
    value: 60,
    unit: "s",
    group: "Connection shape",
    help: "Average time a connection stays open. Active connections are new connections per second times this lifetime.",
    format: "number" as const,
  },
  {
    id: "responseKB",
    label: "Response body and headers",
    min: 1,
    max: 50,
    step: 1,
    value: 5,
    unit: " KB",
    group: "Payload",
    help: "Average response body and headers in kilobytes. The model adds 1 KB for request headers and body so processed bytes count both directions.",
    format: "number" as const,
  },
  {
    id: "ruleCount",
    label: "Rule evaluations per request",
    min: 1,
    max: 50,
    step: 1,
    value: 8,
    unit: " rules",
    group: "Routing",
    help: "Average rules evaluated per request, not the total configured rule count. The first 10 evaluations per request are free; only evaluations above 10 count.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

type Dimension = "new" | "active" | "bytes" | "rules";

interface Demand {
  requestRate: number;
  requestsPerConnection: number;
  connectionSeconds: number;
  responseKB: number;
  bytesPerRequest: number;
  ruleCount: number;
  newConnections: number;
  activeConnections: number;
  bytesPerHour: number;
  ruleEvaluations: number;
  newLcu: number;
  activeLcu: number;
  bytesLcu: number;
  ruleLcu: number;
  totalLcu: number;
  dominant: Dimension;
  spendIndex: number;
  lcuPerMillion: number;
}

function demand(p: Params): Demand {
  const requestRate = Math.max(1, num(p, "requestRate", TOTAL_RPS));
  const requestsPerConnection = Math.max(1, num(p, "requestsPerConnection", 20));
  const connectionSeconds = Math.max(1, num(p, "connectionSeconds", 60));
  const responseKB = Math.max(0, num(p, "responseKB", 5));
  const ruleCount = Math.max(0, Math.round(num(p, "ruleCount", 8)));

  const newConnections = requestRate / requestsPerConnection;
  const activeConnections = newConnections * connectionSeconds;
  const bytesPerRequest = responseKB + REQUEST_BYTES_KB;
  const bytesPerHour = (requestRate * bytesPerRequest * 1_000 * 3_600) / 1_000_000_000;
  const ruleEvaluations = Math.max(0, ruleCount - FREE_RULES) * requestRate;

  const newLcu = newConnections / NEW_CONNECTIONS_PER_LCU;
  const activeLcu = activeConnections / ACTIVE_CONNECTIONS_PER_LCU;
  const bytesLcu = bytesPerHour / GB_PER_LCU_HOUR;
  const ruleLcu = ruleEvaluations / RULE_EVALUATIONS_PER_LCU;

  const dimensions: [Dimension, number][] = [
    ["new", newLcu],
    ["active", activeLcu],
    ["bytes", bytesLcu],
    ["rules", ruleLcu],
  ];
  const dominant = dimensions.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  const totalLcu = Math.max(newLcu, activeLcu, bytesLcu, ruleLcu);

  return {
    requestRate,
    requestsPerConnection,
    connectionSeconds,
    responseKB,
    bytesPerRequest,
    ruleCount,
    newConnections,
    activeConnections,
    bytesPerHour,
    ruleEvaluations,
    newLcu,
    activeLcu,
    bytesLcu,
    ruleLcu,
    totalLcu,
    dominant,
    spendIndex: totalLcu / ILLUSTRATIVE_PLAN_LCU,
    lcuPerMillion: totalLcu / Math.max(1, (requestRate * 3_600) / 1_000_000),
  };
}

function dominantLabel(value: Dimension): string {
  if (value === "new") return "new connections";
  if (value === "active") return "active connections";
  if (value === "bytes") return "processed bytes";
  return "rule evaluations";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const budgetHealth = healthFor(d.spendIndex, 1.25, 1.75);
  const dimensionBars = `New ${d.newLcu.toFixed(0)} · Active ${d.activeLcu.toFixed(0)} · Bytes ${d.bytesLcu.toFixed(0)} · Rules ${d.ruleLcu.toFixed(0)} LCU`;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: d.requestRate,
        sublabel: `${formatCount(d.requestRate)} rps`,
        detail: `Each client connection carries ${d.requestsPerConnection.toFixed(0)} requests on average and stays open for ${d.connectionSeconds.toFixed(0)} seconds.`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: "ok",
        utilization: clamp(d.totalLcu / (ILLUSTRATIVE_PLAN_LCU * 2)),
        throughput: d.requestRate,
        sublabel: `${formatCount(d.totalLcu)} LCU demand`,
        detail: `Serving normally. Billing is the maximum of the four dimensions, not their sum: ${dimensionBars}.`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Target group",
        kind: "service",
        health: "ok",
        utilization: clamp(d.requestRate / 60_000),
        throughput: d.requestRate,
        sublabel: "healthy targets",
        detail: "The target group is healthy. This module changes cost, not target capacity.",
        meta: { view: "flow" },
      },
      {
        id: "budget",
        label: "LCU cost guardrail",
        kind: "external",
        health: budgetHealth,
        sublabel: `${d.spendIndex.toFixed(2)}× illustrative plan`,
        detail: `Illustrative plan: ${ILLUSTRATIVE_PLAN_LCU} LCU. This is a teaching budget, not an AWS quota or a price. Dominant dimension: ${dominantLabel(d.dominant)}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", d.requestRate / 100_000, "ok"),
      edge("alb-targets", "alb", "targets", d.requestRate / 60_000, "ok"),
      edge("alb-budget", "alb", "budget", clamp(d.spendIndex / 4), budgetHealth, "billing"),
    ],
    metrics: [
      metric("lcu-total", "Total LCU demand", d.totalLcu, " LCU", undefined, undefined, "number"),
      metric("lcu-new", "New connections dimension", d.newLcu, " LCU", undefined, undefined, "number"),
      metric("lcu-active", "Active connections dimension", d.activeLcu, " LCU", undefined, undefined, "number"),
      metric("lcu-bytes", "Processed bytes dimension", d.bytesLcu, " LCU", undefined, undefined, "number"),
      metric("lcu-rules", "Rule evaluations dimension", d.ruleLcu, " LCU", 500, 800, "number"),
      metric("spend-index", "LCU demand vs illustrative plan", d.spendIndex, "×", 1.25, 1.75, "number"),
      metric("bytes-per-request", "Processed bytes per request (both directions)", d.bytesPerRequest, " KB", 12, 20, "number"),
      metric("lcu-per-million", "LCU per million requests", d.lcuPerMillion, " LCU", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, dominant: d.dominant, paramsKey: "" },
    summary: `${formatCount(d.totalLcu)} LCU (${d.spendIndex.toFixed(2)}× plan); dominant dimension ${dominantLabel(d.dominant)}; ${d.lcuPerMillion.toFixed(1)} LCU per million requests.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.01 + 0.05;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.985 + 0.03 * Math.sin((index + (seed % 5)) / 2.4)) +
          Math.sin(index / 2.0) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "bytes-per-request",
    metricId: "bytes-per-request",
    warn: 12,
    crit: 20,
    title: "Processed bytes per request is driving the bill",
    cause:
      "Responses grew while request count stayed flat. Processed bytes counts both directions; the model includes 1 KB of request overhead plus the response, so a larger payload or uncompressed JSON moves the byte dimension faster than any connection metric.",
    fix:
      "Compress responses, cache static or repeated bodies at the edge, paginate large payloads, and move large object downloads off the load balancer path. Re-check target CPU after compression; the tradeoff moved.",
    checkFirst: [
      "Compare ProcessedBytes per request before and after the deploy.",
      "Check average response size in access logs and whether compression is enabled.",
      "Check whether a CDN or object store can serve the large bodies instead of the ALB.",
    ],
  },
  {
    id: "lcu-rules",
    metricId: "lcu-rules",
    warn: 500,
    crit: 800,
    title: "Rule evaluations are the dominant LCU dimension",
    cause:
      "Requests evaluate rules until a match. The first 10 evaluations per request are free for LCU billing; above that, the average evaluations per request times request rate becomes an LCU dimension of its own. This model treats the slider as evaluations per request, not the configured rule count.",
    fix:
      "Consolidate rules, put the highest-priority matches first, remove unused rules, and move host or path routing that does not need ALB features to a CDN or API gateway. Measure RuleEvaluations before and after.",
    checkFirst: [
      "Compare RuleEvaluations with RequestCount; the ratio is the evaluations per request.",
      "Count listener rules and identify rules that never match in access logs.",
      "Check whether a recent deploy added a catch-all rule that forces evaluation of the rest.",
    ],
  },
  {
    id: "spend-index",
    metricId: "spend-index",
    warn: 1.25,
    crit: 1.75,
    title: "LCU demand is above the illustrative plan",
    cause:
      "The load balancer is billed on the single highest LCU dimension. A traffic change moved that dimension, so the bill grew faster than request count. The plan in this model is an illustrative budget, not an AWS quota.",
    fix:
      "Attribute the overage to the highest dimension before changing anything. For bytes, compress or cache responses at the edge. For connections, increase reuse or shorten lifetimes. For rules, consolidate listener rules below the 10 free evaluations or move routing to a CDN or gateway.",
    checkFirst: [
      "Compare ConsumedLCUs with NewConnectionCount, ActiveConnectionCount, ProcessedBytes, and RuleEvaluations for the same window.",
      "Calculate each dimension as a share of the total; the highest share is the one that sets the bill.",
      "Check whether the response size, connection lifetime, or rule count changed at the same time as the bill.",
    ],
  },

];

export const albLcuCostModel: SimModel = {
  id: "alb-lcu-cost",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.004, 0.004);
    next.metrics = next.metrics.map((item) =>
      item.id === "lcu-per-million" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    const previousDominant = String(frame.flags.dominant ?? "");
    if (frame.t > 0 && previousDominant && previousDominant !== d.dominant) {
      pushEvent(next, {
        id: "dominant-dimension-change",
        at: frame.t,
        severity: "info",
        title: `Dominant LCU dimension changed to ${dominantLabel(d.dominant)}`,
        detail: `The bill is set by the highest dimension, not the sum. Current demand: ${formatCount(d.newLcu)} new-connection LCU, ${formatCount(d.activeLcu)} active-connection LCU, ${formatCount(d.bytesLcu)} byte LCU, ${formatCount(d.ruleLcu)} rule LCU.`,
        nodeId: "budget",
        metricId: "spend-index",
      });
    }
    next.flags.dominant = d.dominant;
    next.summary = `${formatCount(d.totalLcu)} LCU (${d.spendIndex.toFixed(2)}× plan); dominant dimension ${dominantLabel(d.dominant)}; ${d.lcuPerMillion.toFixed(1)} LCU per million requests.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `The bill is set by ${dominantLabel(d.dominant)} at ${formatCount(d.totalLcu)} LCU. The four dimensions are not added together.`,
    );
    items.push(
      `New connections: ${formatCount(d.newLcu)} LCU. Active connections: ${formatCount(d.activeLcu)} LCU at ${formatCount(d.activeConnections)} open connections.`,
    );
    items.push(
      `Processed bytes: ${formatCount(d.bytesLcu)} LCU from ${d.bytesPerHour.toFixed(0)} GB per hour. Rule evaluations: ${formatCount(d.ruleLcu)} LCU from ${formatCount(d.ruleEvaluations)} evaluations per second.`,
    );
    if (d.ruleCount <= FREE_RULES) {
      items.push("At 10 rule evaluations per request or fewer, the rule-evaluation dimension is zero for LCU billing.");
    }
    if (d.bytesPerRequest >= 12) {
      items.push(
        "The byte dimension is large enough to dominate. Compression, edge caching, or pagination changes the bill more than connection tuning.",
      );
    }
    if (d.activeLcu > d.bytesLcu && d.activeLcu > d.newLcu) {
      items.push(
        "Active connections dominate. Long lifetimes or low reuse are the cost driver, not payload size.",
      );
    }
    items.push(
      `LCU demand is ${d.spendIndex.toFixed(2)}× the illustrative ${ILLUSTRATIVE_PLAN_LCU} LCU plan. This plan is a teaching value, not an AWS quota or price.`,
    );
    return items;
  },
  legend: [
    { label: "Within plan", tone: "ok" },
    { label: "Above plan", tone: "warn" },
    { label: "Well above plan", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "20k rps, 5 KB responses, 20 requests per connection, 8 evaluations per request: 0.86× the illustrative plan.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "24k rps with 8 KB responses. The byte dimension moves first and the plan is exceeded.",
    tone: "warn",
    params: defaults({ requestRate: 24_000, responseKB: 8 }),
  },
  {
    id: "failure",
    label: "Bytes bill",
    description: "30k rps with 20 KB responses. Bytes are 4.5× the plan while connections stay low.",
    tone: "crit",
    params: defaults({ requestRate: 30_000, responseKB: 20 }),
  },
  {
    id: "rules",
    label: "Rules bill",
    description: "50 rule evaluations per request at 25k rps. Rule evaluations alone are 1,000 LCU.",
    tone: "crit",
    params: defaults({ requestRate: 25_000, responseKB: 4, ruleCount: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "15k rps, 3 KB responses, 30 evaluations per request, and high reuse: 0.60× the plan.",
    tone: "ok",
    params: defaults({ requestRate: 15_000, responseKB: 3, ruleCount: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-active-connection-lcu",
  title: "Predict the LCU dimension for long-lived connections",
  simId: "lcu-cost",
  question:
    "A service moves to 40,000 new WebSocket connections per second, each held for 600 seconds, with a 1 KB message and 8 rule evaluations per request. Which LCU dimension sets the bill?",
  prediction: {
    options: [
      { id: "active", label: "Active connections, because 24 million connections are open at once" },
      { id: "new", label: "New connections, because 40,000 connections are created every second" },
      { id: "bytes", label: "Processed bytes, because every message is billed in both directions" },
      { id: "rules", label: "Rule evaluations, because every message traverses the listener rules" },
    ],
    correctOptionId: "active",
    explanation:
      "Active connections are new connections per second multiplied by lifetime: 40,000 × 600 = 24,000,000 open connections. At 3,000 active connections per LCU-minute, that is 8,000 LCU. New connections are 40,000 ÷ 25 = 1,600 LCU, processed bytes are about 288 LCU, and 8 evaluations per request stay below the free rule evaluations. The maximum, not the sum, is the billed dimension.",
  },
  setup: defaults({
    requestRate: 40_000,
    requestsPerConnection: 1,
    connectionSeconds: 600,
    responseKB: 1,
    ruleCount: 8,
  }),
  runFor: 20,
  observe: [
    "Active connections reach 8,000 LCU from 24 million open connections.",
    "New connections are 1,600 LCU and processed bytes are about 288 LCU.",
    "Rule evaluations remain zero because 8 evaluations per request are below the 10 free evaluations.",
    "Total demand is 16× the illustrative plan even though request payloads are tiny.",
  ],
  explain:
    "LCU billing is a maximum across dimensions. Long-lived connections make the active-connection dimension enormous while the byte dimension stays small. Adding more bandwidth or bigger messages would not change the bill; reducing lifetime or increasing reuse would. If the workload genuinely needs long sessions, the active-connection dimension is the capacity plan, not an anomaly.",
  fix: defaults({
    requestRate: 40_000,
    requestsPerConnection: 20,
    connectionSeconds: 300,
    responseKB: 1,
    ruleCount: 8,
  }),
  debrief:
    "With 20 requests per connection and a 300-second lifetime, active connections fall to 600,000 and the active dimension to 200 LCU. Processed bytes remain at 288 LCU, so the total drops from 8,000 to 288. Reuse removed the active-connection bill; the next dimension is bytes.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Load Balancer Capacity Unit (LCU) is the billing and capacity measure for an Application Load Balancer (ALB). AWS measures four dimensions and charges for the highest one, not their sum. The dimensions are new connections, active connections, processed bytes, and rule evaluations. Each dimension is averaged over an hour, so a short spike can be diluted, but a sustained shape change moves the bill.",
  },
  {
    type: "p",
    text: "The trap is attribution. A bill can double while request count, target CPU, and error rate stay flat. The request rate did not change; the shape did. A deploy may add a large response body, a client may switch from pooled requests to one connection per request, a WebSocket rollout may extend connection lifetime, or a routing change may add listener rules. Each one moves a different dimension.",
  },
  {
    type: "table",
    headers: ["LCU dimension", "What one LCU covers", "Primary signal"],
    rows: [
      ["New connections", "25 new connections per second", "NewConnectionCount"],
      ["Active connections", "3,000 active connections per minute (1,500 with mutual TLS)", "ActiveConnectionCount"],
      ["Processed bytes", "1 GB per hour for EC2, container, and IP targets (0.4 GB per hour for Lambda)", "ProcessedBytes"],
      ["Rule evaluations", "1,000 rule evaluations per second; the first 10 evaluations per request are free", "RuleEvaluations"],
    ],
  },
  {
    type: "p",
    text: "Those per-LCU allowances are AWS-documented. The 500 LCU plan used in this lab is an illustrative budget, not an AWS quota, reservation, or price. Prices vary by Region and change over time, so the lab measures LCU demand and a dimensionless multiple of the plan rather than inventing a dollar figure.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The ALB sits between clients and the target group. It accepts connections, terminates HTTP or HTTPS, evaluates listener rules, and forwards requests. The LCU dimensions map to those stages: connection creation, connection retention, bytes moved in both directions, and rule evaluation. A change anywhere in that path can move the dominant dimension without moving the others.",
  },
  {
    type: "compare",
    leftTitle: "Byte-heavy API",
    rightTitle: "Connection-heavy API",
    rows: [
      { label: "Typical shape", left: "Few long requests with large JSON or file responses", right: "Many short messages or streams on long-lived connections" },
      { label: "Dominant dimension", left: "Processed bytes", right: "Active or new connections" },
      { label: "First lever", left: "Compress, cache, paginate, move objects to a CDN or object store", right: "Increase reuse, shorten lifetime, or plan for the open-connection count" },
      { label: "Misleading metric", left: "Request count looks normal", right: "CPU and request latency look normal" },
    ],
  },
  {
    type: "p",
    text: "Rule evaluation is the quiet dimension. The first 10 rule evaluations per request are free; above that, the product of extra evaluations per request and request rate can dominate. A rule set that grew one rule at a time is a common cause of a bill that jumps after an otherwise small routing change.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Four dimension bars in LCU, plus the total LCU demand and the dominant dimension.",
      "The LCU demand as a multiple of an illustrative plan, and LCU per million requests.",
      "Client connection shape controls: request rate, requests per connection, and connection lifetime.",
      "Payload and routing controls: response size and listener rule count.",
      "A cost guardrail node that marks the plan breach while the ALB and targets stay healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Bytes bill and watch the processed-bytes bar pass the others while connection metrics barely move. Apply Rules bill and watch the rule bar take over. Then open the experiment, predict the WebSocket result, and run it. Change one lever at a time; the dominant dimension is the one to fix first.",
  },
  {
    type: "table",
    headers: ["Lever", "Moves", "Tradeoff"],
    rows: [
      ["Compress or cache responses", "Processed bytes", "CPU or cache complexity; compression can hurt already-compressed media"],
      ["Increase requests per connection", "New and active connections", "Client and server keep-alive behavior must cooperate"],
      ["Shorten connection lifetime", "Active connections", "More connection churn and TLS handshakes"],
      ["Consolidate listener rules", "Rule evaluations", "Routing logic may become less expressive or move to another tier"],
      ["Move large objects off the ALB", "Processed bytes", "Another service and another cache or bucket to operate"],
    ],
  },
  { type: "sim", simId: "lcu-cost" },
  { type: "experiment", experimentId: "predict-active-connection-lcu" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The bill was set by one dimension at a time. In the byte incident, response size moved processed bytes to several times the plan while new and active connections stayed low. In the rule incident, 50 rule evaluations per request at 25k rps produced 1,000 rule-evaluation LCU with a small response. The ALB stayed healthy in both cases because LCU is a billing measure, not an availability limit.",
  },
  {
    type: "p",
    text: "The WebSocket experiment inverted the usual intuition. Twenty-four million open connections produced 8,000 active-connection LCU while 1 KB messages produced about 288 byte LCU. Increasing reuse and shortening lifetime cut the total to 288 LCU; the remaining bill is now bytes, not connections.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch ALB: `ConsumedLCUs`, `NewConnectionCount`, `ActiveConnectionCount`, `ProcessedBytes`, and `RuleEvaluations`, with the load balancer and target group dimensions.",
      "Access logs: request and response size, request count per connection, and the matched rule priority. These explain why a dimension moved.",
      "Client telemetry: connection reuse, keep-alive behavior, and session lifetime. A client library change can move the bill without a server deploy.",
      "Cost Explorer and the pricing calculator: the dollar view, after the LCU attribution. Do not infer the dimension from the dollar total alone.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute each dimension as a share of total LCU. The highest share is the one that sets the bill. Then ask what changed in that dimension: response size, connection lifetime, reuse, or rule count. A rising bill with flat request count and flat latency is a shape change, not a traffic increase.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Attribute the overage to one dimension using the four CloudWatch metrics.",
      "Confirm the change that moved it: payload size, connection shape, or rule count.",
      "For bytes, compress, cache, paginate, or move large objects to a CDN or object store.",
      "For connections, increase reuse and shorten lifetime where the protocol allows it.",
      "For rules, consolidate and order listener rules; keep the set at or below 10 if the routing allows it.",
      "Re-check the next dimension after the fix; the bill moves to the new maximum, not to zero.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Compression reduces bytes but adds CPU and can increase latency on small responses.",
      "Longer connection lifetimes reduce new-connection LCU but increase active-connection LCU; the better choice depends on reuse.",
      "Caching at the edge reduces ALB bytes but adds invalidation and cache-key correctness work.",
      "Consolidating rules reduces rule-evaluation LCU but can make routing harder to reason about.",
      "A larger LCU reservation protects against sudden scaling, not against a cost shape change; you still pay for what you consume.",
      "The cheapest dimension to fix is the one that is actually dominant. Optimizing a low dimension feels productive and changes nothing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "attribute-lcu-bill",
    question:
      "The ALB bill doubled after a release, but request rate, target CPU, and p99 are flat. How do you find the dimension that moved?",
    difficulty: 3,
    hints: [
      "LCU is the maximum of four dimensions, not the sum.",
      "Request count can stay flat while connection shape or payload size changes.",
    ],
    answer:
      "I would pull ConsumedLCUs and the four inputs for the same window: NewConnectionCount, ActiveConnectionCount, ProcessedBytes, and RuleEvaluations. Then I would convert each to LCU and compare shares before and after the release. If bytes are flat but active connections jumped, a client or protocol change increased lifetime or reduced reuse. If ResponseBytes per request jumped, a payload or compression change is the cause. If RuleEvaluations per request jumped, the release added rules. I would check access logs for response size and matched rule priority, and client telemetry for connection reuse. The dollar total cannot tell me which dimension moved.",
    followUps: [
      "What would make you suspect the byte dimension even if request count fell?",
      "How does a WebSocket rollout change the attribution?",
      "Which dimension would you alert on and at what multiple of plan?",
    ],
    redFlags: [
      "Sums the four dimensions and calls that the LCU count.",
      "Starts by buying a larger reservation without attributing the change.",
      "Assumes request rate is the only cost driver.",
    ],
    rubric: [
      "Names all four dimensions.",
      "Converts metrics to LCU and compares shares.",
      "Checks payload, connection shape, and rules separately.",
      "States what evidence would falsify the diagnosis.",
    ],
  },
  {
    id: "reduce-lcu",
    question:
      "You must cut ALB LCU cost by 30% without hurting availability. What levers do you try, in what order, and what can go wrong?",
    difficulty: 3,
    hints: [
      "The dominant dimension decides the lever.",
      "Every lever has a latency, correctness, or operational cost.",
    ],
    answer:
      "First I attribute the cost to the dominant dimension. If it is processed bytes, I try compression, edge caching, pagination, and moving large objects to object storage; the risks are CPU, cache correctness, and a worse experience for already-compressed media. If it is active connections, I increase reuse or shorten lifetime; the risk is more handshakes and churn, and some clients cannot keep connections alive. If it is new connections, I check why clients are not pooling. If it is rule evaluations, I consolidate and reorder rules, with the risk of losing routing expressiveness. I would make one change, measure the dimension and the user-facing latency, and keep a rollback. A reservation is a capacity decision, not a cost reduction.",
    followUps: [
      "When would moving traffic to a CDN make the total cost worse?",
      "How do you prove the fix did not just move the bottleneck to the targets?",
      "What is the risk of setting a very long keep-alive?",
    ],
    redFlags: [
      "Cuts response size without checking whether bytes are dominant.",
      "Buys a reservation and calls it savings.",
      "Changes several levers at once and cannot attribute the result.",
    ],
    rubric: [
      "Starts from the dominant dimension.",
      "Names a concrete lever and its tradeoff.",
      "Measures before and after.",
      "Keeps availability and rollback in view.",
    ],
  },
  {
    id: "lcu-reservation",
    question:
      "Does an LCU reservation cap throughput or guarantee a fixed bill? Explain what it actually does.",
    difficulty: 3,
    hints: [
      "A reservation is a minimum capacity commitment, not a ceiling.",
      "ConsumedLCUs still reports actual consumption.",
    ],
    answer:
      "A reservation commits to a minimum amount of capacity and bills for it, while the load balancer continues to scale above it when traffic demands. It is not a throughput cap and not a fixed bill. If I reserve 1,000 LCU and consume 600, I pay for the reservation; if I consume 1,400, I pay the reservation plus the overage. PeakLCUs helps size the reservation for scaling, while ConsumedLCUs is the billing view. A reservation protects against a sudden spike that outruns automatic scaling; it does not make a cost shape change disappear.",
    followUps: [
      "Which metric would you use to size a reservation?",
      "What happens during a traffic spike above the reservation?",
      "When is a reservation the wrong tool?",
    ],
    redFlags: [
      "Says the reservation caps LCU consumption.",
      "Confuses reserved capacity with a price discount.",
      "Ignores overage billing.",
    ],
    rubric: [
      "Calls it a minimum commitment.",
      "States that scaling continues above it.",
      "Names PeakLCUs and ConsumedLCUs.",
      "Distinguishes capacity from price.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show all four LCU dimensions and ConsumedLCUs per load balancer.",
      "The dominant dimension is reviewed after every traffic-shape or routing change.",
      "Response size, connection reuse, and listener rule count are tracked as change signals.",
      "The illustrative plan or reservation has an owner and a review date.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Convert each dimension to LCU and compare shares before and after the change.",
      "Check the change log for payload, client connection, or rule changes.",
      "Fix the dominant dimension first; do not tune a low dimension.",
      "Watch the next dimension after the fix, not only the bill total.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression check for LCU per million requests.",
      "Document the connection-shape assumption in the client and server configuration.",
      "Review listener rules for unused or catch-all entries.",
      "Re-check the plan or reservation against the new steady state.",
    ],
  },
];

const references = [
  {
    title: "Elastic Load Balancing pricing: LCU details",
    url: "https://aws.amazon.com/elasticloadbalancing/pricing/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The four LCU dimensions, per-LCU allowances, and the highest-dimension billing rule.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ConsumedLCUs, NewConnectionCount, ActiveConnectionCount, ProcessedBytes, and RuleEvaluations.",
  },
  {
    title: "Capacity reservations for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/capacity-unit-reservation.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Reservations set a minimum capacity; the load balancer still scales above it.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "lcu-cost": {
      model: albLcuCostModel,
      presets,
      instructions:
        "Start Healthy, then apply Bytes bill and Rules bill. Compare the four dimension metrics rather than the total. Run the WebSocket experiment and then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The four LCU definitions and per-LCU allowances are AWS-documented; the 500 LCU plan, response-size thresholds, and rule-cost guardrails are teaching values, not AWS quotas, prices, or guarantees. No dollar price is modeled.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-connection-limit",
    "traffic-nlb-in-front-of-alb",
    "traffic-cdn-cache-keys",
  ],
};
