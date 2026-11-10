import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DAYS_PER_MONTH = 30;
const SECONDS_PER_DAY = 86_400;
const BASELINE_EXPENSIVE_SHARE = 10;
const EXPENSIVE_MULTIPLIER = 5;
const RAMP_START = 4;
const RAMP_END = 26;

const params = [
  {
    id: "trafficM",
    label: "Traffic",
    min: 10,
    max: 500,
    step: 10,
    value: 100,
    unit: " M req/day",
    group: "Traffic",
    help: "Sustained requests per day. The monthly model uses 30 days, not the calendar month.",
    format: "number" as const,
  },
  {
    id: "fixedCostK",
    label: "Fixed monthly cost",
    min: 10,
    max: 200,
    step: 5,
    value: 40,
    unit: " k$",
    group: "Cost",
    help: "Cost that does not move with request volume: baseline fleet, databases, platform, and committed spend. Illustrative.",
    format: "number" as const,
  },
  {
    id: "variableCostPerM",
    label: "Baseline variable cost",
    min: 2,
    max: 40,
    step: 1,
    value: 8,
    unit: " $/M",
    group: "Cost",
    help: "Cost per million requests on the ordinary path. Illustrative, not an AWS quote.",
    format: "number" as const,
  },
  {
    id: "expensiveSharePct",
    label: "Expensive-path share",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Mix",
    help: "Share of requests that take the expensive path. The model ramps the mix over about 20 simulated seconds.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function expensiveShareAt(p: Params, t: number): number {
  const target = clamp(num(p, "expensiveSharePct", 20), 0, 100);
  const start = Math.min(BASELINE_EXPENSIVE_SHARE, target);
  const progress = smoothstep((t - RAMP_START) / (RAMP_END - RAMP_START));
  return start + (target - start) * progress;
}

interface Computed {
  trafficM: number;
  volumeM: number;
  fixedCost: number;
  expensiveShare: number;
  variablePerM: number;
  variableCost: number;
  totalCost: number;
  unitCost: number;
  billK: number;
  fixedShare: number;
  rps: number;
}

function compute(p: Params, t: number): Computed {
  const trafficM = Math.max(1, num(p, "trafficM", 100));
  const fixedCost = Math.max(0, num(p, "fixedCostK", 40)) * 1_000;
  const baseVariable = Math.max(0, num(p, "variableCostPerM", 8));
  const expensiveShare = expensiveShareAt(p, t);
  const volumeM = trafficM * DAYS_PER_MONTH;
  const mixFactor = 1 + (EXPENSIVE_MULTIPLIER - 1) * (expensiveShare / 100);
  const variablePerM = baseVariable * mixFactor;
  const variableCost = volumeM * variablePerM;
  const totalCost = fixedCost + variableCost;
  return {
    trafficM,
    volumeM,
    fixedCost,
    expensiveShare,
    variablePerM,
    variableCost,
    totalCost,
    unitCost: totalCost / volumeM,
    billK: totalCost / 1_000,
    fixedShare: (fixedCost / Math.max(1, totalCost)) * 100,
    rps: (trafficM * 1_000_000) / SECONDS_PER_DAY,
  };
}

function costHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.unitCost >= 45 || values.billK >= 150) return "crit";
  if (values.unitCost >= 35 || values.billK >= 110) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["cost-per-million", values.unitCost, 0.35],
    ["monthly-bill", values.billK, 0.8],
    ["expensive-share", values.expensiveShare, 0.6],
    ["effective-variable-cost", values.variablePerM, 0.15],
    ["traffic", values.trafficM, 0.4],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + (seed % 11)) / 2.9);
      return Math.max(0, value * (0.98 + 0.02 * wave) + amplitude * Math.sin(index / 2.2));
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  t: number,
  seed: number,
  state: { mixEvent: boolean },
): SimFrame {
  const values = compute(p, t);
  const health = costHealth(values);
  const pathHealth: "ok" | "warn" | "crit" =
    values.expensiveShare >= 70 ? "crit" : values.expensiveShare >= 40 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client requests",
        kind: "client",
        health: "ok",
        throughput: values.rps,
        sublabel: `${(values.trafficM * 30).toFixed(0)}M requests/month`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Expensive path",
        kind: "cdn",
        health: pathHealth,
        throughput: values.rps * (values.expensiveShare / 100),
        sublabel: `${values.expensiveShare.toFixed(0)}% of traffic`,
        detail: "Rendering, data transfer, or a downstream call that costs several times the ordinary path.",
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        role: "instance",
        health,
        throughput: values.rps,
        sublabel: `${Math.round(values.rps).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "data",
        label: "Data and storage",
        kind: "db",
        health: "ok",
        throughput: values.rps,
        sublabel: "per-request reads and writes",
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Monthly bill",
        kind: "storage",
        health,
        sublabel: `${values.billK.toFixed(1)}k$ · ${values.unitCost.toFixed(2)}$/M`,
        detail: `${values.fixedShare.toFixed(0)}% of the bill is fixed. Every cost figure in this model is illustrative.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", clamp(values.expensiveShare / 100), pathHealth),
      edge("client-app", "client", "app", clamp(1 - values.expensiveShare / 100), health),
      edge("edge-app", "edge", "app", clamp(values.expensiveShare / 100), pathHealth),
      edge("app-data", "app", "data", clamp(values.rps / 4_000), "ok"),
      edge("app-bill", "app", "bill", clamp(values.rps / 3_000), health),
    ],
    metrics: [
      metric("cost-per-million", "Cost per million requests", values.unitCost, " $/M", 35, 45, "number"),
      metric("monthly-bill", "Monthly run rate", values.billK, " k$", 110, 150, "number"),
      metric("effective-variable-cost", "Variable cost per million", values.variablePerM, " $/M", undefined, undefined, "number"),
      metric("expensive-share", "Expensive-path share", values.expensiveShare, "%", undefined, undefined, "percent"),
      metric("traffic", "Traffic", values.trafficM, " M req/day", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      mixEvent: state.mixEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.trafficM.toFixed(0)}M requests/day cost ${values.billK.toFixed(1)}k$/month, or ${values.unitCost.toFixed(2)}$ per million. ${values.expensiveShare.toFixed(0)}% of traffic takes the expensive path. Illustrative figures.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, 0, seed, { mixEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cost-per-million",
    metricId: "cost-per-million",
    warn: 35,
    crit: 45,
    title: "Unit cost is rising",
    cause:
      "Total cost is growing faster than request volume, or the mix has moved toward a more expensive path. A flat request rate with a rising unit cost rules out volume as the cause.",
    fix:
      "Break the bill down by usage dimension and endpoint, then compare cost per request for each path. Reduce the expensive path's resource intensity or shift traffic away from it before raising prices or budgets.",
    checkFirst: [
      "Compare requests per day with total cost over the same window.",
      "Split cost per request by endpoint, payload size, and downstream call.",
      "Check whether a release, default change, or cache miss shifted the traffic mix.",
    ],
  },
  {
    id: "monthly-bill",
    metricId: "monthly-bill",
    warn: 110,
    crit: 150,
    title: "The run rate is above plan",
    cause:
      "The bill reflects both volume and unit cost. A bill increase with flat traffic must come from unit cost or from a fixed-cost step, not from more requests.",
    fix:
      "Attribute the increase before cutting anything: separate fixed, variable, and expensive-path cost. Then size the fix against the dimension that moved, not against the total bill.",
    checkFirst: [
      "Check the cost and usage report for the largest change by service and usage type.",
      "Compare the current run rate with the forecast and the budget.",
      "Check whether a fixed-cost commitment or minimum capacity changed at the same time.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const costPerRequestModel: SimModel = {
  id: "capacity-cost-per-request",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let mixEvent = fresh ? false : frame.flags.mixEvent === 1;
    const targetShare = num(p, "expensiveSharePct", 20);
    const share = expensiveShareAt(p, t);

    const next = buildFrame(p, t, Number(frame.flags.seed ?? 20261110), { mixEvent });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!mixEvent && targetShare > 40 && share > 20) {
      pushEvent(next, {
        id: "mix-shift",
        at: t,
        severity: "warn",
        title: "Traffic is moving to the expensive path",
        detail: `The expensive share has reached ${share.toFixed(0)}%. Request volume is flat, but each request now consumes more of the bill.`,
        nodeId: "edge",
        metricId: "cost-per-million",
      });
      mixEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      mixEvent: mixEvent ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const unit = value("cost-per-million");
    const bill = value("monthly-bill");
    const share = value("expensive-share");
    const traffic = value("traffic");
    const items: string[] = [
      `${traffic.toFixed(0)}M requests/day produce a ${bill.toFixed(1)}k$ monthly run rate at ${unit.toFixed(2)}$ per million. All figures are illustrative.`,
    ];
    if (share >= 40) {
      items.push(
        `${share.toFixed(0)}% of requests take the expensive path. That mix change raises unit cost even when the request rate does not move.`,
      );
    } else {
      items.push("The mix is stable. A bill increase here is mostly volume or a fixed-cost step, not a per-request regression.");
    }
    items.push(
      "Compare cost per request over time before comparing total spend. The total tells you what changed; the unit cost tells you why.",
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
    description: "A 100M requests/day baseline whose expensive-path share ramps from 10% to 20%.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Volume and mix",
    description: "Traffic grows 20% while the expensive-path share reaches 70%; the bill nearly doubles.",
    tone: "warn",
    params: defaults({ trafficM: 120, expensiveSharePct: 70 }),
  },
  {
    id: "failure",
    label: "Flat traffic, rising cost",
    description: "Traffic stays at 100M requests/day while the expensive path grows to 95% of requests.",
    tone: "crit",
    params: defaults({ trafficM: 100, expensiveSharePct: 95 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The mix returns to 15% and the fixed base drops to 35k$; unit cost falls below the warning line.",
    tone: "ok",
    params: defaults({ trafficM: 120, fixedCostK: 35, variableCostPerM: 6, expensiveSharePct: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-flat-traffic-cost",
  title: "Predict why the bill rises with flat traffic",
  simId: "cost-per-request",
  question:
    "Request volume stays at 100M per day, but the monthly run rate climbs by more than 80%. What is the most likely cause?",
  prediction: {
    options: [
      { id: "volume", label: "The request rate is growing faster than the dashboard shows" },
      { id: "mix", label: "A larger share of requests now takes the expensive path" },
      { id: "month", label: "The model uses a 31-day month rather than 30 days" },
      { id: "fixed", label: "Fixed costs are spread over fewer requests" },
    ],
    correctOptionId: "mix",
    explanation:
      "With traffic flat, only the cost per request can move the bill. The expensive path is five times the variable cost of the ordinary path, so a shift from 10% to 95% raises the effective variable rate by a factor of 3.43 while volume stays constant. A 31-day month would add about 3%, and fixed costs do not rise with the mix.",
  },
  setup: defaults({ trafficM: 100, expensiveSharePct: 95 }),
  runFor: 40,
  observe: [
    "Traffic holds at 100M requests/day for the whole run.",
    "The expensive-path share ramps from 10% to 95% between about 4 and 26 simulated seconds.",
    "The monthly run rate rises from roughly 74k$ to roughly 155k$, and cost per million rises from about 25$ to about 52$.",
    "The fixed-cost share of the bill falls from about 54% to about 26% even though the bill is higher.",
  ],
  explain:
    "Cost per request is total cost divided by requests. The denominator did not move, so the numerator did. The expensive path consumes five times the variable cost, and the mix made it almost all of the traffic. The total bill hides that because a 155k$ bill looks like growth; the unit cost exposes it because it rose while volume was flat.",
  fix: defaults({ trafficM: 100, fixedCostK: 40, variableCostPerM: 8, expensiveSharePct: 20 }),
  debrief:
    "The fix is to reduce the cost of the expensive path or route less traffic through it, not to demand more traffic. Moving the share back to 20% returns the run rate to about 83k$ at the same volume. If the path is required by the product, its cost belongs in the price or in an explicit budget. Every figure here is illustrative.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cost per request is total infrastructure cost divided by requests served. It is a unit metric: a denominator that lets you compare months, endpoints, and tenants without arguing about whether the service grew. The numerator has two parts. Fixed cost does not move with volume in the short term: a baseline fleet, a database, a platform team, a committed minimum. Variable cost moves with each request: compute time, data transfer, storage writes, downstream calls, and telemetry. Cost per request is the sum divided by the request count.",
  },
  {
    type: "p",
    text: "The metric is useful because a total bill conflates two different stories. If traffic doubles and the bill doubles, the service is equally efficient. If traffic grows 20% and the bill doubles, unit cost rose about 67%, and the interesting question is what became more expensive. Conversely, a bill that grows more slowly than traffic means fixed costs are being spread thinner; that is good only if the variable cost per request is not quietly rising. Cost per request keeps the two effects separate.",
  },
  {
    type: "p",
    text: "The denominator needs a definition. A request can mean an HTTP request, a job, a rendered page, a tenant action, or a million events. Pick one, keep it stable across the comparison, and label it. The AWS Cost and Usage Report can give you cost and usage at a fine grain, but it does not know your product unit. You supply that mapping. The model here uses one million requests as the unit so the numbers stay readable; the reasoning is the same for any denominator.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The bill is assembled below the request path. A request reaches the edge, the application fleet, a database or storage layer, and often a downstream service. Each layer contributes fixed cost and variable cost at different rates. The expensive path is not necessarily a different service; it can be a query shape, a payload size, a cache miss, or a feature flag that turns on extra work. The cost model sits beside the request path, not in it, which is why a latency dashboard can look healthy while unit cost is deteriorating.",
  },
  {
    type: "table",
    headers: ["Cost layer", "Behavior", "What moves it", "Typical blind spot"],
    rows: [
      ["Baseline fleet", "Fixed in the short term", "Minimum capacity, commitments, idle replicas", "Idle capacity is invisible in request dashboards"],
      ["Compute per request", "Variable", "CPU time, memory, cold starts, retries", "Averages hide the expensive endpoint"],
      ["Data transfer", "Variable", "Payload size, egress, cross-zone calls", "A release changes response size"],
      ["Storage and retention", "Mixed", "Writes per request, retention, index growth", "Cost grows after traffic stabilizes"],
      ["Telemetry", "Variable", "Logs, traces, metric cardinality", "Observability cost scales with success and failure"],
    ],
  },
  {
    type: "p",
    text: "This module models a fixed monthly base, a variable rate per million requests, and a share of traffic on a path that costs five times the baseline. The multiplier is a teaching value, not an AWS price. The traffic rate is held constant while the mix ramps, so the failure is a pure unit-cost change. In production the mix usually moves with a release, a default, a cache state, or a customer segment, and it can move in either direction.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cost per million requests, with warning at 35$ and critical at 45$ in this illustrative model.",
      "The monthly run rate, so you can see the bill move independently of traffic.",
      "Effective variable cost per million, which isolates the mix from the fixed base.",
      "Expensive-path share, the mix signal that explains a unit-cost change at flat traffic.",
      "A request path from client to edge, application, data, and bill, plus a flat-traffic failure preset.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note that cost per million starts near 24.5$ (73.6k$/month) and settles near 27.7$ (83.2k$/month) as the expensive share ramps to 20% at 100M requests/day. Apply Flat traffic, rising cost and watch the traffic metric stay flat while unit cost crosses the thresholds. Run the guided experiment before moving sliders. Then set the expensive share back to 20% and compare the bill. All dollar figures are illustrative teaching values, not AWS prices.",
  },
  { type: "sim", simId: "cost-per-request" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The request rate never moved. The expensive-path share climbed from 10% to 95%, and because that path costs five times the baseline variable rate, the effective variable cost rose from about 11$ to about 38$ per million. At 3,000 million requests per month, that added roughly 81k$ to the run rate. The fixed base stayed at 40k$, so the bill rose from about 74k$ to about 155k$ while the denominator was constant. All figures in this module are illustrative.",
  },
  {
    type: "p",
    text: "The fixed-cost share fell from more than half of the bill to about a quarter. That is a useful trap: a falling fixed share looks like efficiency, but here it happened because variable cost exploded. Cost per request is the better headline because it moved in the same direction as the user-facing cost, while the total bill alone could be mistaken for growth.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "AWS Cost Explorer: total cost by service and usage type, with a daily or hourly grain. Compare the same window as the request count, not the calendar month.",
      "Cost and Usage Report: line items for data transfer, requests, storage, and compute. Group by a cost allocation tag that identifies the workload or tenant.",
      "Application metrics: requests per endpoint, response bytes, cache hit rate, retries, and downstream calls. The mix change usually appears here first.",
      "Deployment history: a release that changes a default, a payload, an image size, or a feature flag is a common cause of a sudden mix shift.",
      "Budgets and anomaly detection: a forecast or budget alert confirms the run rate, but it cannot tell you which dimension moved. Pair it with the unit metric.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare requests per day with total cost over the same window. If traffic is flat, do not start with capacity. Split cost per request by endpoint and usage type, then check the release history and cache hit rate for a mix change. Only after that decide whether the fix is engineering, pricing, or an explicit budget.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the denominator: the same request definition and the same time window on both sides of the comparison.",
      "Decompose the bill into fixed, baseline variable, and expensive-path variable cost. Do not average across paths that behave differently.",
      "Find the dimension that moved: endpoint share, payload size, egress, retries, storage writes, or telemetry volume.",
      "Reduce the expensive path's cost or its share. Caching, compression, batching, a cheaper storage tier, or a product limit can each change the unit cost.",
      "If the path is required, put its cost into the price or an explicit budget rather than hiding it in the aggregate.",
      "Add a recurring unit-cost review with a stable denominator, and alert on a change in unit cost, not only on total spend.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A unit metric can be gamed by changing the denominator: counting fewer requests, excluding internal calls, or redefining a request. Freeze the definition and document it.",
      "Fixed costs fall per request as volume grows, which can make a service look more efficient while its variable cost is rising.",
      "Cutting the expensive path can remove a feature users value. The cost decision and the product decision need the same owner.",
      "Aggressive caching lowers unit cost but adds staleness and invalidation risk; the saving is real only if correctness holds.",
      "Precise per-request attribution needs tags and instrumentation. The overhead is small compared with the cost of arguing about an unattributed bill.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "decompose-bill",
    question:
      "The bill doubled but traffic grew only 20%. How do you decompose the change before proposing a fix?",
    difficulty: 2,
    hints: [
      "Start with the unit metric, not the total.",
      "Separate fixed cost, variable cost, and traffic mix.",
    ],
    answer:
      "I would compute cost per request for both periods using the same request definition and the same window. If the bill doubled while traffic grew 20%, unit cost rose by about 67%. Then I would split the numerator into fixed, baseline variable, and expensive-path variable cost. Fixed cost should not explain a doubling unless a commitment or capacity step changed. Variable cost can rise from volume, from a higher rate per request, or from a mix shift toward more expensive requests. I would compare cost per request by endpoint and usage type, then check releases and cache behavior for the mix change. Only after attributing the change would I choose between engineering, pricing, and budget.",
    followUps: [
      "Which denominator would you use for a batch product?",
      "How do you separate a price change from a usage change?",
      "What would make you distrust the unit metric?",
    ],
    redFlags: [
      "Starts by cutting the fleet without attribution.",
      "Compares a partial month with a full month.",
      "Treats the total bill as proof of volume growth.",
    ],
    rubric: [
      "Computes unit cost with a stable denominator.",
      "Separates fixed, variable, and mix.",
      "Names a data source for attribution.",
      "Chooses a fix after attributing.",
    ],
  },
  {
    id: "define-request",
    question:
      "How do you define the request unit for cost per request, and what breaks if the definition changes?",
    difficulty: 2,
    hints: [
      "The denominator must be stable across time and comparable across teams.",
      "The product unit and the billing unit are not always the same.",
    ],
    answer:
      "I would pick a unit the product owns: an HTTP request, a rendered page, a completed job, or a tenant action. I would document what counts, what is excluded, and which retries or internal calls are included. The billing data gives cost and usage, but it does not know the product unit, so the mapping has to be explicit. If the definition changes, the unit cost can appear to improve or worsen without any real change. For comparisons across teams, I would keep a canonical definition and add narrower views for endpoints or tenants rather than redefining the headline.",
    followUps: [
      "Would you count retries?",
      "How do you handle a request that fans out to ten services?",
      "What is the risk of using revenue as the denominator?",
    ],
    redFlags: [
      "Uses whatever number makes the trend look good.",
      "Mixes requests and jobs in one series.",
      "Ignores retries and internal fan-out.",
    ],
    rubric: [
      "Defines a stable, product-owned unit.",
      "Documents inclusions and exclusions.",
      "Separates headline and narrower views.",
      "Explains the comparability risk.",
    ],
  },
  {
    id: "falling-unit-cost",
    question:
      "Unit cost is falling every month. Is that always good? What would you check?",
    difficulty: 3,
    hints: [
      "Fixed costs dilute as volume grows.",
      "A rising variable cost can be hidden by a falling fixed share.",
    ],
    answer:
      "Not always. If fixed cost is a large part of the bill, unit cost falls simply because volume grows and the fixed base is spread thinner. That can mask a rising variable cost per request. I would decompose the unit cost into fixed per request and variable per request, then check the variable rate by endpoint. I would also check whether the denominator changed, whether unprofitable traffic was excluded, and whether a cost was moved to another team or account. A falling unit cost with a rising variable rate is a warning, not a win.",
    followUps: [
      "How would you present that split to finance?",
      "What happens when volume plateaus?",
      "Which cost would you expect to step rather than drift?",
    ],
    redFlags: [
      "Treats a falling unit cost as proof of efficiency.",
      "Ignores the denominator.",
      "Does not separate fixed from variable.",
    ],
    rubric: [
      "Explains fixed-cost dilution.",
      "Checks the variable rate separately.",
      "Questions the denominator.",
      "Names a step cost or allocation change.",
    ],
  },
  {
    id: "instrument-unit-cost",
    question:
      "How would you instrument cost per request so an engineer can see the unit cost of the path they own?",
    difficulty: 3,
    hints: [
      "Cost data lags request data.",
      "Tags, endpoint labels, and a stable denominator do the work.",
    ],
    answer:
      "I would combine three streams: cost and usage data with allocation tags, request counts by endpoint or tenant, and resource signals such as bytes, duration, and downstream calls. I would publish a daily unit-cost view with the same denominator and a breakdown by the dimensions the team controls. I would also expose a leading indicator, such as bytes per request or downstream calls per request, because the bill arrives later. The view needs an owner, a documented definition, and an alert on a unit-cost change, not only on total spend. Sampling and cardinality controls keep the instrumentation from becoming its own cost problem.",
    followUps: [
      "How do you attribute shared platform cost?",
      "What lag do you accept between request and cost data?",
      "How do you keep the tag taxonomy from drifting?",
    ],
    redFlags: [
      "Relies on the monthly bill alone.",
      "Has no owner for the unit metric.",
      "Adds unbounded per-request tags.",
    ],
    rubric: [
      "Combines cost, usage, and request data.",
      "Uses a stable denominator and tags.",
      "Adds a leading indicator.",
      "Names ownership and governance.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The request denominator is documented and stable across the periods being compared.",
      "Costs carry allocation tags for workload, tenant, and environment.",
      "The unit-cost dashboard splits fixed, baseline variable, and expensive-path variable cost.",
      "Releases that change payloads, defaults, or fan-out are reviewed for unit-cost impact.",
      "A budget or anomaly alert exists, plus a unit-cost alert with a stable denominator.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare requests per day with total cost over the same window before touching capacity.",
      "Split unit cost by endpoint and usage type to find the dimension that moved.",
      "Check the release and feature-flag history for a mix change.",
      "Check cache hit rate, retries, payload size, and egress if the mix is stable.",
      "Record the denominator, the window, and the attribution before proposing a fix.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the expensive path to the unit-cost review with its own rate and share.",
      "Decide whether the fix is engineering, pricing, or an explicit budget, and assign an owner.",
      "Re-run the comparison with the same denominator to confirm the change.",
      "Remove or re-scope any instrumentation that added cost without attribution.",
    ],
  },
];

const references = [
  {
    title: "Cost Optimization Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Expenditure awareness, cost-effective resources, and measuring efficiency against a business metric.",
  },
  {
    title: "Analyzing your costs and usage with AWS Cost Explorer",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Grouping cost and usage by service, tag, and time window for unit-cost comparisons.",
  },
  {
    title: "Managing your costs with AWS Budgets",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cost, usage, and coverage budgets with forecast and threshold notifications.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cost-per-request": {
      model: costPerRequestModel,
      presets,
      instructions:
        "Start healthy, then apply Flat traffic, rising cost. Watch traffic stay flat while cost per million and the run rate climb. Use Recovery to restore the mix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative cost model. Dollar rates and the expensive-path multiplier are teaching values, not AWS prices or quotes. Traffic is modelled as 30 days per month.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-unit-economics",
    "capacity-headroom-cost",
    "observability-telemetry-cost",
    "case-composite-cost-surprise",
  ],
};
