import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "productionRps",
    label: "Production request rate",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second reaching the production service. The mirror percentage is applied to this rate.",
    format: "rps",
  },
  {
    id: "mirrorPercent",
    label: "Mirrored traffic",
    min: 1,
    max: 100,
    step: 1,
    value: 10,
    unit: "%",
    group: "Traffic",
    help: "Share of production requests copied to the shadow version. Responses from the shadow are discarded.",
    format: "percent",
  },
  {
    id: "writeRequestPercent",
    label: "Mirrored requests that write",
    min: 0,
    max: 100,
    step: 5,
    value: 5,
    unit: "%",
    group: "Side effects",
    help: "Share of mirrored requests that create, update, delete, or call an external system. A read-only mirror sets this to zero.",
    format: "percent",
  },
  {
    id: "shadowCapacityRps",
    label: "Shadow capacity",
    min: 500,
    max: 30_000,
    step: 500,
    value: 12_000,
    unit: " rps",
    group: "Capacity",
    help: "Safe request capacity of the shadow service and its dependencies at the latency target, in requests per second.",
    format: "rps",
  },
  {
    id: "idempotencyCoverage",
    label: "Write idempotency coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Side effects",
    help: "Share of mirrored writes that can be applied more than once without changing the outcome or repeating an external effect.",
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

interface Values {
  shadowLoad: number;
  shadowUtil: number;
  mirroredWrites: number;
  duplicateWrites: number;
  primaryP99: number;
}

function compute(p: Params): Values {
  const productionRps = Math.max(1, num(p, "productionRps", 12_000));
  const mirror = clamp(num(p, "mirrorPercent", 10) / 100, 0.01, 1);
  const writeShare = clamp(num(p, "writeRequestPercent", 5) / 100, 0, 1);
  const capacity = Math.max(1, num(p, "shadowCapacityRps", 12_000));
  const idempotency = clamp(num(p, "idempotencyCoverage", 100) / 100, 0, 1);

  const shadowLoad = productionRps * mirror;
  const shadowUtil = (shadowLoad / capacity) * 100;
  const mirroredWrites = shadowLoad * writeShare;
  const duplicateWrites = mirroredWrites * (1 - idempotency);
  const primaryP99 = 120 + Math.max(0, shadowUtil / 100 - 0.7) ** 2 * 2_500;

  return { shadowLoad, shadowUtil, mirroredWrites, duplicateWrites, primaryP99 };
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function perSecond(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k/s` : `${value.toFixed(0)}/s`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const loadHealth = highHealth(values.shadowUtil, 70, 90);
  const sideEffectHealth = highHealth(values.duplicateWrites, 1, 20);
  const primaryHealth = highHealth(values.primaryP99, 250, 800);

  const stageNodes = [
    {
      id: "primary",
      label: "Production v1",
      kind: "service" as const,
      health: primaryHealth,
      utilization: clamp(num(p, "productionRps", 12_000) / 40_000),
      throughput: num(p, "productionRps", 12_000),
      capacity: 40_000,
      sublabel: `serving users · p99 ${values.primaryP99.toFixed(0)}ms`,
      detail: "The production version returns every response to the user. Shadow responses never reach this path.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "shadow",
      label: "Shadow v2",
      kind: "service" as const,
      health: worst(loadHealth, sideEffectHealth),
      utilization: clamp(values.shadowUtil / 100),
      throughput: values.shadowLoad,
      capacity: Math.max(1, num(p, "shadowCapacityRps", 12_000)),
      sublabel: `${percent(values.shadowUtil)} of capacity · responses discarded`,
      detail: `A copy of ${percent(num(p, "mirrorPercent", 10))} of traffic reaches the shadow. Its responses are discarded, but its work still consumes capacity and can write to shared systems.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "effects",
      label: "Side-effect ledger",
      kind: "db" as const,
      health: sideEffectHealth,
      utilization: clamp(values.duplicateWrites / 100),
      sublabel: `${perSecond(values.duplicateWrites)} duplicate writes`,
      detail: `Mirrored writes create ${perSecond(values.mirroredWrites)} write operations per second. With ${percent(100 - num(p, "idempotencyCoverage", 100))} lacking idempotency, ${perSecond(values.duplicateWrites)} repeat an effect.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "users", label: "Users", kind: "client" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "prod",
      label: "Production v1",
      kind: "service" as const,
      health: primaryHealth,
      sublabel: `${Math.round(num(p, "productionRps", 12_000)).toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "mirror",
      label: "Mirror policy",
      kind: "mesh" as const,
      health: "ok" as Health,
      sublabel: `${percent(num(p, "mirrorPercent", 10))} copied`,
      meta: { view: "flow" },
    },
    {
      id: "shadow-flow",
      label: "Shadow v2",
      kind: "service" as const,
      health: worst(loadHealth, sideEffectHealth),
      sublabel: `${percent(values.shadowUtil)} utilization`,
      meta: { view: "flow" },
    },
    {
      id: "writes",
      label: "Shared writes",
      kind: "db" as const,
      health: sideEffectHealth,
      sublabel: `${perSecond(values.duplicateWrites)} duplicates`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("users-prod", "users", "prod", num(p, "productionRps", 12_000) / 40_000, primaryHealth),
      edge("prod-mirror", "prod", "mirror", num(p, "mirrorPercent", 10) / 100, "ok"),
      edge("mirror-shadow", "mirror", "shadow-flow", clamp(values.shadowUtil / 100), loadHealth),
      edge("shadow-writes", "shadow-flow", "writes", clamp(values.duplicateWrites / 100), sideEffectHealth),
    ],
    metrics: [
      metric("shadow-utilization", "Shadow utilization", values.shadowUtil, "%", 70, 90, "percent"),
      metric("duplicate-writes", "Duplicate side effects", values.duplicateWrites, "/s", 1, 20, "rps"),
      metric("primary-p99", "Primary p99", values.primaryP99, "ms", 250, 800, "ms"),
      metric("mirrored-writes", "Mirrored writes", values.mirroredWrites, "/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), duplicateWrites: values.duplicateWrites },
    summary: `${(values.shadowLoad / 1000).toFixed(1)}k rps shadowed · ${percent(values.shadowUtil)} capacity · ${perSecond(values.duplicateWrites)} duplicate effects`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 8)) / 2.5);
  for (const [id, value] of [
    ["shadow-utilization", values.shadowUtil],
    ["duplicate-writes", values.duplicateWrites],
    ["primary-p99", values.primaryP99],
    ["mirrored-writes", values.mirroredWrites],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "shadow-utilization",
    metricId: "shadow-utilization",
    warn: 70,
    crit: 90,
    title: "Shadow traffic saturates the shadow capacity",
    cause: "Mirroring a large share of production sends the shadow a second full workload. If the shadow shares nodes, network, or downstream limits with production, the copy can degrade the primary path.",
    fix: "Reduce the mirror share, add isolated capacity, or mirror only a representative sample. Never let the shadow consume the headroom the production service needs.",
    checkFirst: [
      "Compare shadow request rate with its provisioned capacity.",
      "Check whether the shadow shares nodes, connection pools, or dependencies with production.",
      "Check primary p99 for a rise at the same timestamp as shadow load.",
    ],
  },
  {
    id: "duplicate-writes",
    metricId: "duplicate-writes",
    warn: 1,
    crit: 20,
    title: "Shadow writes are repeating real side effects",
    cause: "The mirror copies write requests, and the shadow applies them to the shared database or an external system. Responses are discarded, but the effects are not. Retries make the duplication worse.",
    fix: "Stop mirroring writes. Mirror reads only, suppress write calls in the shadow, or point the shadow at an isolated sandbox. If writes must be mirrored, require idempotency keys and deduplicate every effect.",
    checkFirst: [
      "Check whether the mirror policy copies non-idempotent methods.",
      "Check the shared database and external API for duplicates.",
      "Check whether the shadow uses the production credential and endpoint.",
    ],
  },
  {
    id: "primary-p99",
    metricId: "primary-p99",
    warn: 250,
    crit: 800,
    title: "Shadow load is slowing the user path",
    cause: "The shadow shares a bottleneck with production. Even though its responses are discarded, its requests compete for connections, CPU, bandwidth, or a downstream quota.",
    fix: "Isolate the shadow's capacity and dependencies, reduce the mirror percentage, or pause the experiment. Treat the shadow as a production workload with its own limits.",
    checkFirst: [
      "Check whether primary p99 rose when shadow load rose.",
      "Check shared connection pools and downstream quotas.",
      "Check network and node saturation on the shared path.",
    ],
  },
];

export const shadowTrafficModel: SimModel = {
  id: "deployment-shadow-traffic",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (resetSeries) seedSeries(next, values, seed);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${percent(num(p, "mirrorPercent", 10))} of ${Math.round(num(p, "productionRps", 12_000)).toLocaleString()} rps is mirrored, so the shadow handles ${Math.round(values.shadowLoad).toLocaleString()} rps in addition to production.`,
    );
    items.push(
      `The shadow runs at ${percent(values.shadowUtil)} of its capacity. Discarded responses do not make the work free.`,
    );
    items.push(
      `${percent(num(p, "writeRequestPercent", 5))} of mirrored requests write. At ${percent(num(p, "idempotencyCoverage", 100))} idempotency coverage, ${perSecond(values.duplicateWrites)} duplicate effects per second reach shared systems.`,
    );
    items.push(
      `Primary p99 is ${values.primaryP99.toFixed(0)}ms. A shared bottleneck turns the shadow experiment into a production latency event.`,
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
    description: "A 10% read-mostly mirror with idempotent writes and isolated capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Half mirrored",
    description: "Half of production is mirrored and idempotency coverage is high but not complete.",
    tone: "warn",
    params: defaults({ mirrorPercent: 50, writeRequestPercent: 5, shadowCapacityRps: 12_000, idempotencyCoverage: 95 }),
  },
  {
    id: "failure",
    label: "Writes mirrored",
    description: "The full write path is copied to a small shadow with weak idempotency.",
    tone: "crit",
    params: defaults({ productionRps: 20_000, mirrorPercent: 100, writeRequestPercent: 50, shadowCapacityRps: 8_000, idempotencyCoverage: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Full mirroring with enough isolated capacity and complete write deduplication.",
    tone: "ok",
    params: defaults({ productionRps: 20_000, mirrorPercent: 100, writeRequestPercent: 50, shadowCapacityRps: 30_000, idempotencyCoverage: 100 }),
  },
  {
    id: "read-only",
    label: "Read-only mirror",
    description: "Every request is mirrored, but writes are suppressed. Capacity is still undersized.",
    tone: "crit",
    params: defaults({ productionRps: 20_000, mirrorPercent: 100, writeRequestPercent: 0, shadowCapacityRps: 8_000, idempotencyCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-shadow-risk",
  title: "Predict the first risk of mirroring production",
  simId: "shadow",
  question:
    "You mirror 100% of production traffic, including checkout writes, to a shadow version so it sees real behavior. What must you solve before starting?",
  prediction: {
    options: [
      { id: "side-effects", label: "Writes and external calls that the shadow would repeat" },
      { id: "responses", label: "Making sure shadow responses reach users" },
      { id: "routing", label: "Removing production traffic from the primary version" },
      { id: "logging", label: "Disabling shadow logs so they do not affect performance" },
    ],
    correctOptionId: "side-effects",
    explanation:
      "Mirroring copies the request, not just the read. A shadow that writes to the production database or calls a payment or email provider creates real effects even though its response is discarded. Reads can be mirrored broadly; writes need suppression, isolation, or idempotency before the experiment starts.",
  },
  setup: defaults({ productionRps: 20_000, mirrorPercent: 100, writeRequestPercent: 50, shadowCapacityRps: 8_000, idempotencyCoverage: 20 }),
  runFor: 30,
  observe: [
    "The shadow receives 20k rps against 8k of capacity, so utilization reaches 250%.",
    "Duplicate side effects reach 8k per second.",
    "Primary p99 rises to over 8 seconds as the shared path saturates.",
    "The shadow response itself is discarded; the damage comes from load and writes.",
  ],
  explain:
    "A shadow copy duplicates work, not users. That distinction makes read mirroring a useful validation tool and write mirroring a production change with external effects. The experiment must isolate capacity and suppress or deduplicate writes before any traffic is copied.",
  fix: defaults({ productionRps: 20_000, mirrorPercent: 100, writeRequestPercent: 0, shadowCapacityRps: 30_000, idempotencyCoverage: 100 }),
  debrief:
    "The read-only fix mirrors the full request rate with no duplicate writes and enough isolated capacity. Primary p99 stays at baseline. The cost is that write-path behavior is no longer validated by real traffic, so those paths need synthetic tests or a dedicated sandbox with test accounts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Shadow traffic, also called request mirroring or dark traffic, copies production requests to a new version while the production version still returns every response to the user. The shadow's responses are discarded. This lets a team compare behavior on real request shapes, headers, and data without putting users on the new code.",
  },
  {
    type: "p",
    text: "The copy is not free. It doubles work for the shadow path, consumes capacity, and reaches shared dependencies. Read requests are usually safe to mirror at a sampled rate. Write requests are not: a mirrored payment, email, or database write creates a real effect even though the response is thrown away. The experiment design has to isolate capacity and either suppress writes or make them idempotent and observable.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A proxy, service mesh, or load balancer applies a mirror policy to a share of traffic. The primary request continues to production; a copy goes to the shadow service, often with a header marking it as mirrored. The shadow may use the same dependencies, a sandbox, or read replicas. Its logs, traces, and diffs are the actual output of the experiment.",
  },
  {
    type: "p",
    text: "The rates and thresholds here are illustrative. The structural rule is that the shadow is a production workload with a separate capacity budget and a write policy. If it shares a bottleneck with production, the experiment can cause the incident it was meant to prevent.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Shadow utilization: the mirrored request rate against the shadow's safe capacity.",
      "Duplicate side effects per second: writes or external calls repeated by the shadow.",
      "Primary p99: whether the copy is consuming a shared bottleneck.",
      "Mirrored writes: the write volume the experiment introduces.",
      "A deployment view with production, shadow, and the shared side-effect ledger.",
    ],
  },
  {
    type: "table",
    headers: ["Request type", "Safe to mirror?", "Required control"],
    rows: [
      ["Read-only query", "Usually", "Sample rate and isolated capacity"],
      ["Idempotent write", "With care", "Idempotency key and deduplication"],
      ["Non-idempotent write", "No by default", "Suppress or route to a sandbox"],
      ["External side effect", "No by default", "Sandbox credential and no-op adapter"],
      ["Authentication or payment", "No by default", "Test accounts and isolated provider"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and compare the shadow rate with production. Apply Half mirrored to see utilization rise without side effects. Apply Writes mirrored to see duplicate effects and primary latency. Apply Read-only mirror to separate load from writes, then run the experiment and apply its fix.",
  },
  { type: "sim", simId: "shadow" },
  { type: "experiment", experimentId: "predict-shadow-risk" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset mirrored the full production rate into a shadow with 40% of the capacity. Utilization reached 250%, primary p99 rose above eight seconds, and 8,000 duplicate side effects per second hit shared systems. The shadow responses were discarded, but the work and the writes were real.",
  },
  {
    type: "p",
    text: "The read-only preset kept the load failure and removed the side effects. That separates the two risks: capacity is a sizing problem, while writes are an isolation problem. The recovery preset shows full mirroring working only when capacity is isolated and every write is deduplicated.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Duplicate rows, emails, charges, or tickets created at the same rate as the mirror.",
      "Primary latency rising with shadow request rate.",
      "Shadow errors that are invisible because its responses are discarded.",
      "Shared connection pools or downstream quotas consumed by the copy.",
      "Mirror headers or trace tags that identify which requests were copied.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the mirror policy for write methods before enabling it. Check the shadow's capacity against the mirrored rate. Check primary p99 and shared dependency quotas. Check the side-effect ledger for duplicates. Stop the mirror first if writes are escaping.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop mirroring writes or route the shadow to an isolated sandbox.",
      "Suppress external calls with a no-op adapter or test credential.",
      "Give the shadow its own capacity budget and dependencies where possible.",
      "Mirror a sample of reads rather than every request when capacity is shared.",
      "Compare shadow and production results with trace IDs and diff reports.",
      "Tear down the mirror and its data before the experiment becomes permanent.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full mirroring gives realistic coverage but doubles load and needs isolated capacity.",
      "Sampling reduces cost but can miss rare request shapes and tail behavior.",
      "Read-only mirroring is safe for side effects but does not validate write paths.",
      "A sandbox protects production data but may not reproduce production data distribution or latency.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "mirror-writes",
    question:
      "You want to shadow a checkout rewrite. Which requests would you mirror and which would you suppress?",
    difficulty: 3,
    hints: [
      "Separate reads from writes.",
      "An external effect is not undone by discarding the response.",
      "A sandbox can validate writes without production effects.",
    ],
    answer:
      "I would mirror browse, cart, pricing, and other read paths at a sampled rate, with the shadow isolated from production capacity. I would suppress payment authorization, order creation, email, inventory decrement, and any third-party call, or route them to a sandbox with test accounts and no-op adapters. If a write must be exercised, I would use an idempotency key and a deduplication store, and I would verify that the shadow cannot use production credentials.",
    followUps: [
      "How would you validate the write path without real effects?",
      "What could still leak through a sandbox?",
      "How do you compare shadow results with production results?",
    ],
    redFlags: ["Mirrors all methods.", "Relies on discarding responses.", "Uses production credentials."],
    rubric: ["Separates reads and writes.", "Suppresses external effects.", "Isolates credentials and capacity.", "Plans comparison."],
  },
  {
    id: "capacity",
    question: "How do you size capacity for a shadow experiment?",
    difficulty: 3,
    hints: [
      "Start from the mirrored rate, not the production total.",
      "The shadow may share dependencies.",
      "Leave headroom for production spikes.",
    ],
    answer:
      "I would multiply the production request rate by the mirror percentage, then add the shadow's own overhead and retry behavior. I would provision capacity for the mirror plus the production peak, or isolate the shadow so it cannot consume production headroom. I would watch utilization, p99, queue depth, and downstream quotas, and set a mirror kill switch that trips before production is affected.",
    followUps: [
      "What mirror percentage would you start with?",
      "Which shared dependency is most dangerous?",
      "How do you test the kill switch?",
    ],
    redFlags: ["Sizes for average traffic only.", "Assumes discarded responses are free.", "No kill switch."],
    rubric: ["Uses mirrored rate.", "Accounts for shared dependencies.", "Adds headroom.", "Defines a kill switch."],
  },
  {
    id: "validation",
    question: "What does shadow traffic prove, and what does it not prove?",
    difficulty: 2,
    hints: [
      "It sees real requests.",
      "It does not return real responses to users.",
      "Load and write behavior differ.",
    ],
    answer:
      "It proves that the new version can parse real request shapes, exercise real data, and produce comparable results without user-visible risk. It does not prove that users will accept the response, that the write path is correct end to end, or that the system behaves the same under the full production load if the mirror is sampled or isolated. Those need canary, synthetic write tests, or a controlled launch.",
    followUps: [
      "How would you compare responses?",
      "What would make a shadow result misleading?",
      "When would you move from shadow to canary?",
    ],
    redFlags: ["Claims shadow proves user acceptance.", "Ignores sampling.", "Assumes write paths are covered."],
    rubric: ["Names realistic coverage.", "States limits.", "Mentions comparison.", "Chooses a next gate."],
  },
  {
    id: "kill-switch",
    question: "What would make you stop a shadow experiment immediately?",
    difficulty: 2,
    hints: [
      "User impact comes first.",
      "Writes are a hard stop.",
      "Capacity is a close second.",
    ],
    answer:
      "Any sign of user impact: rising primary errors or p99, saturation on a shared dependency, or a duplicate external effect. I would also stop on unexpected write traffic, a credential reaching production, or a cost or quota spike. The mirror should have a kill switch that an on-call engineer can use without a deploy, and stopping it should leave the primary path untouched.",
    followUps: [
      "Who can pull the switch?",
      "How do you confirm the mirror stopped?",
      "What evidence do you preserve?",
    ],
    redFlags: ["Waits for a full incident.", "Requires a deploy to stop.", "Ignores duplicate writes."],
    rubric: ["Stops on user impact.", "Treats writes as urgent.", "Has a fast switch.", "Preserves evidence."],
  },
];

const checklist = [
  {
    title: "Before the experiment",
    items: [
      "Classify every mirrored route as read, idempotent write, or non-idempotent write.",
      "Suppress or isolate non-idempotent writes and external calls.",
      "Size shadow capacity for the mirror plus production peak.",
      "Use separate credentials and a sandbox where possible.",
      "Define the kill switch, owner, and stop conditions.",
    ],
  },
  {
    title: "During the experiment",
    items: [
      "Start with a small read-only sample and increase gradually.",
      "Watch primary p99, errors, and shared dependency quotas.",
      "Check the side-effect ledger for duplicates.",
      "Compare shadow responses with production using trace IDs.",
    ],
  },
  {
    title: "After the experiment",
    items: [
      "Stop the mirror and remove shadow credentials.",
      "Review coverage: which request shapes and write paths were not tested.",
      "Record the comparison results and any behavior differences.",
      "Decide the next gate: canary, synthetic write tests, or more shadowing.",
    ],
  },
];

const references = [
  {
    title: "Envoy request mirror policy",
    url: "https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto",
    publisher: "Envoy Proxy",
    kind: "docs" as const,
    note: "Route-level request mirroring and sampling configuration.",
  },
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Exposure, validation, and the limits of testing on a traffic sample.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    shadow: {
      model: shadowTrafficModel,
      presets,
      instructions:
        "Start with Healthy, then apply Half mirrored. Apply Writes mirrored to see duplicate effects and shared latency, then Read-only mirror to separate load from writes. Apply Recovery, then run the experiment and its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Request rates, capacity, and duplicate counts are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-dark-launch", "deployment-canary", "deployment-feature-flags", "deployment-canary-metric-gate"],
};
