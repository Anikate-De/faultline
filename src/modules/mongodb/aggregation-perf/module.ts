import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_P99_MS = 1_800;
const MEMORY_LIMIT_MB = 100;
const STAGE_NAMES = ["$group", "$sort", "$project"] as const;

const params: ParamSpec[] = [
  {
    id: "collectionDocs",
    label: "Collection size",
    min: 5,
    max: 100,
    step: 5,
    value: 20,
    unit: "M docs",
    group: "Data",
    help: "Documents the pipeline can read. A scan before the filter pays for every document, not only the matches.",
    format: "number",
  },
  {
    id: "selectivity",
    label: "$match selectivity",
    min: 0.5,
    max: 10,
    step: 0.5,
    value: 2,
    unit: "%",
    group: "Query",
    help: "Share of documents that pass the filter. A selective filter early in the pipeline removes most of the work before expensive stages.",
    format: "percent",
  },
  {
    id: "stagesBeforeMatch",
    label: "Stages before $match",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Pipeline",
    help: "How many blocking stages run before the filter. Zero means $match can use an index at the start; later positions force the pipeline to process documents the filter will discard.",
    format: "count",
  },
  {
    id: "limitEarly",
    label: "$limit before blocking stage",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Pipeline",
    help: "1 places a limit before the blocking stage so later stages handle fewer documents. It does not reduce the scan that happens before the limit or the work already done by earlier stages.",
    format: "count",
  },
  {
    id: "allowDiskUse",
    label: "allowDiskUse",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Memory",
    help: "1 lets a stage that exceeds 100 MB spill to temporary files. 0 makes the operation fail instead. Spilling protects memory but adds disk I/O and latency.",
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
  total: number;
  matched: number;
  docsBefore: number;
  docsAfter: number;
  memoryMB: number;
  spillMB: number;
  p99: number;
  stagesBefore: number;
  limitEarly: boolean;
  allowDiskUse: boolean;
  stageHealth: Health;
  clientHealth: Health;
}

function compute(p: Params): Computed {
  const total = clamp(num(p, "collectionDocs", 20), 5, 100) * 1_000_000;
  const selectivity = clamp(num(p, "selectivity", 2), 0.5, 10) / 100;
  const stagesBefore = Math.round(clamp(num(p, "stagesBeforeMatch", 0), 0, 3));
  const limitEarly = num(p, "limitEarly", 1) >= 0.5;
  const allowDiskUse = num(p, "allowDiskUse", 1) >= 0.5;
  const matched = total * selectivity;
  const docsBefore = stagesBefore === 0 ? matched : total;
  const docsAfter = limitEarly && stagesBefore > 0 ? Math.min(docsBefore, 5_000) : docsBefore;
  const memoryMB = Math.min(4_000, docsAfter * 0.00002);
  const spillMB = allowDiskUse && memoryMB > MEMORY_LIMIT_MB ? memoryMB - MEMORY_LIMIT_MB : 0;
  const spillCost = memoryMB > MEMORY_LIMIT_MB ? (allowDiskUse ? spillMB * 1.5 : 900) : 0;
  const p99 = Math.min(MAX_P99_MS, 3 + docsBefore / 100_000 + spillCost);
  const stageHealth: Health =
    memoryMB > MEMORY_LIMIT_MB && !allowDiskUse ? "crit" : memoryMB > MEMORY_LIMIT_MB || p99 >= 300 ? "warn" : "ok";
  const clientHealth: Health = p99 >= 300 ? "crit" : p99 >= 100 ? "warn" : "ok";
  return {
    total,
    matched,
    docsBefore,
    docsAfter,
    memoryMB,
    spillMB,
    p99,
    stagesBefore,
    limitEarly,
    allowDiskUse,
    stageHealth,
    clientHealth,
  };
}

function stageNodes(values: Computed): SimNode[] {
  const order: { id: string; label: string; detail: string }[] = [];
  for (let index = 0; index < values.stagesBefore; index++) {
    const name = STAGE_NAMES[index] ?? "$project";
    order.push({
      id: name.slice(1),
      label: name,
      detail:
        name === "$group"
          ? "A blocking grouping stage must see every input document before it can emit a group."
          : name === "$sort"
            ? "A blocking sort holds the working set in memory unless it can use an index."
            : "A projection changes document shape but cannot make earlier work cheaper.",
    });
  }
  order.push({
    id: "match",
    label: "$match",
    detail:
      values.stagesBefore === 0
        ? "The filter runs first, so the planner can use an index on the filtered field."
        : "The filter runs after blocking work. An index on the original field cannot be used here because the earlier stages have already changed what flows through the pipeline.",
  });
  for (let index = values.stagesBefore; index < STAGE_NAMES.length; index++) {
    const name = STAGE_NAMES[index];
    order.push({
      id: name.slice(1),
      label: name,
      detail:
        name === "$group"
          ? "A blocking grouping stage must see every input document before it can emit a group. The working set is bounded by the per-stage memory limit."
          : name === "$sort"
            ? "A blocking sort holds the working set in memory; above the limit it spills when allowDiskUse permits it."
            : "A projection narrows the document shape. It reduces bytes per document, not the number of documents already processed.",
    });
  }
  return order.map((stage, index) => ({
    id: `stage-${stage.id}`,
    label: stage.label,
    kind: "service" as const,
    health: stage.id === "match" && values.stagesBefore > 0 ? "warn" : values.stageHealth,
    utilization: values.memoryMB > MEMORY_LIMIT_MB ? clamp(values.memoryMB / 400) : clamp(index / 10),
    sublabel:
      stage.id === "match"
        ? values.stagesBefore === 0
          ? `first · ${Math.round(values.matched).toLocaleString()} docs`
          : `after ${values.stagesBefore} stage(s)`
        : `${Math.round(values.docsAfter).toLocaleString()} docs`,
    detail: stage.detail,
    meta: { view: "flow" },
  }));
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const stages = stageNodes(values);
  const nodes: SimNode[] = [
    {
      id: "collection",
      label: "Collection",
      kind: "db",
      health: "ok",
      sublabel: `${(values.total / 1_000_000).toFixed(0)}M documents`,
      detail: "The pipeline starts from the collection. A $match here can use an index; a $match after a blocking stage cannot.",
      meta: { view: "flow" },
    },
    ...stages,
    {
      id: "client",
      label: "Client",
      kind: "client",
      health: values.clientHealth,
      sublabel: `${Math.round(values.matched).toLocaleString()} rows · p99 ${values.p99.toFixed(0)}ms`,
      detail: "The client waits for the final result. The tail includes every stage, including a spill to disk.",
      meta: { view: "flow" },
    },
  ];
  const ordered = ["collection", ...stages.map((stage) => stage.id), "client"];
  const edges = ordered.slice(1).map((to, index) =>
    edge(`pipe-${index}`, ordered[index], to, 0.8, values.clientHealth),
  );
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("pipeline-p99", "Pipeline p99", values.p99, "ms", 100, 300, "ms"),
      metric("peak-memory", "Peak stage memory", values.memoryMB, " MB", 80, 400, "number"),
      metric("docs-processed", "Documents processed", values.docsBefore, "", 5_000_000, 20_000_000, "count"),
      metric("spill-mb", "Spilled to disk", values.spillMB, " MB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      stagesBefore: values.stagesBefore,
      memoryLimited: !values.allowDiskUse && values.memoryMB > MEMORY_LIMIT_MB ? 1 : 0,
    },
    summary: `$match at stage ${values.stagesBefore + 1} · ${Math.round(values.docsBefore).toLocaleString()} docs processed · ${values.memoryMB.toFixed(0)} MB peak · p99 ${values.p99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 6)) / 2.3);
  for (const [id, value] of [
    ["pipeline-p99", values.p99],
    ["peak-memory", values.memoryMB],
    ["docs-processed", values.docsBefore],
    ["spill-mb", values.spillMB],
  ] as const) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pipeline-p99",
    metricId: "pipeline-p99",
    warn: 100,
    crit: 300,
    title: "The pipeline spends its time before the filter",
    cause:
      "Blocking stages such as $group and $sort must process their entire input before producing output. If $match runs after them, the pipeline processes the whole collection and discards most of it at the end. A spill to disk adds more time.",
    fix:
      "Move $match to the start of the pipeline so it can use an index, then keep $sort and $group after the filter. Add or move $limit before a blocking stage. Use allowDiskUse only as a safety valve, not as a substitute for reducing input.",
    checkFirst: [
      "Check the stage order and how many documents enter each stage.",
      "Check whether the $match predicate has a supporting index.",
      "Check `usedDisk`, spills, and peak memory in the operation's explain or profile output.",
    ],
  },
  {
    id: "peak-memory",
    metricId: "peak-memory",
    warn: 80,
    crit: 400,
    title: "A blocking stage exceeded its memory budget",
    cause:
      "MongoDB allows a pipeline stage to use about 100 MB before it must spill or fail. A large $group or $sort working set crosses that limit when the pipeline carries too many documents into the stage.",
    fix:
      "Reduce the input with an earlier $match, add a $limit before the blocking stage when the result allows it, or enable allowDiskUse so the stage spills instead of failing. Then measure whether the spill still meets the latency budget.",
    checkFirst: [
      "Check which stage holds the working set.",
      "Check whether $match or $limit runs before that stage.",
      "Check allowDiskUse and the usedDisk indicator.",
    ],
  },
  {
    id: "docs-processed",
    metricId: "docs-processed",
    warn: 5_000_000,
    crit: 20_000_000,
    title: "The pipeline carries the whole collection",
    cause:
      "A filter near the end of the pipeline cannot reduce work done by earlier stages. Every document that enters a blocking stage contributes to memory, CPU, and possibly disk I/O.",
    fix:
      "Put equality filters in a $match at the start, keep only the fields later stages need, and move limits ahead of blocking stages. Verify that the filter is selective enough to matter.",
    checkFirst: [
      "Check documents entering each stage, not only the final result count.",
      "Check whether the first stage can use an index.",
      "Check whether a limit is applied before or after the expensive stage.",
    ],
  },
];

export const aggregationPerfModel: SimModel = {
  id: "mongodb-aggregation-perf",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.8, 0.8);
    next.metrics = next.metrics.map((item) =>
      item.id === "pipeline-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.stagesBefore > 0 && !Number(next.flags.lateMatchAnnounced ?? 0)) {
      pushEvent(next, {
        id: "late-match",
        at: frame.t,
        severity: values.p99 >= 300 ? "crit" : "warn",
        title: "A late $match is processing the whole collection",
        detail: `${values.stagesBefore} stage(s) run before the filter. The pipeline processes ${Math.round(values.docsBefore).toLocaleString()} documents and keeps ${Math.round(values.matched).toLocaleString()}.`,
        nodeId: "stage-match",
        metricId: "docs-processed",
      });
      next.flags.lateMatchAnnounced = 1;
    }
    if (values.memoryMB > MEMORY_LIMIT_MB && !values.allowDiskUse && !Number(next.flags.memoryAnnounced ?? 0)) {
      pushEvent(next, {
        id: "memory-limit-exceeded",
        at: frame.t,
        severity: "crit",
        title: "A blocking stage exceeded the memory limit",
        detail: `The stage needs ${values.memoryMB.toFixed(0)} MB against a documented per-stage limit of about 100 MB. With allowDiskUse disabled, the operation fails instead of spilling.`,
        metricId: "peak-memory",
      });
      next.flags.memoryAnnounced = 1;
    }
    if (values.stagesBefore === 0) next.flags.lateMatchAnnounced = 0;
    if (values.allowDiskUse || values.memoryMB <= MEMORY_LIMIT_MB) next.flags.memoryAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The filter runs after ${values.stagesBefore} stage(s), so the pipeline processes ${Math.round(values.docsBefore).toLocaleString()} documents to keep ${Math.round(values.matched).toLocaleString()}. An index can only help at the start of the pipeline.`,
      `Peak working memory is ${values.memoryMB.toFixed(0)} MB. The documented per-stage limit is about 100 MB; above it, allowDiskUse spills to temporary files and adds I/O, while disabling it makes the operation fail.`,
      values.limitEarly
        ? "A limit before the blocking stage reduces the working set for later stages. It does not undo the scan or grouping that happened before it."
        : "Without an early limit, every matched document enters the blocking stage and contributes to the working set.",
      "Illustrative model. Document counts and latency are teaching values; check the real pipeline's explain output for `usedDisk`, spills, and stage memory.",
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
    description: "The filter runs first, the index narrows the input, and the pipeline stays in memory.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A blocking stage runs before the filter, so a larger working set spills to disk.",
    tone: "warn",
    params: defaults({ collectionDocs: 6, stagesBeforeMatch: 1, limitEarly: 0 }),
  },
  {
    id: "failure",
    label: "Late $match",
    description: "Three stages run before the filter and the working set crosses the memory limit with no spill allowed.",
    tone: "crit",
    params: defaults({ collectionDocs: 40, stagesBeforeMatch: 3, limitEarly: 0, allowDiskUse: 0 }),
  },
  {
    id: "spill",
    label: "Disk spill",
    description: "The pipeline spills instead of failing, but the disk round trip still breaches the latency budget.",
    tone: "warn",
    params: defaults({ collectionDocs: 10, stagesBeforeMatch: 1, limitEarly: 0, allowDiskUse: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The filter is first, a limit trims the working set, and the pipeline stays inside the memory budget.",
    tone: "ok",
    params: defaults({ collectionDocs: 20, stagesBeforeMatch: 0, limitEarly: 1, allowDiskUse: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-late-match",
  title: "Predict where the aggregation spends its time",
  simId: "aggregation-perf",
  question:
    "An index exists on `customerId`, but the pipeline runs `$group`, then `$match` on `customerId`. Why is it slow?",
  prediction: {
    options: [
      { id: "index-broken", label: "The index is corrupt because the pipeline changed the document shape" },
      { id: "late", label: "The $match cannot use the index after $group, so every document is grouped first" },
      { id: "network", label: "The client is slow to read the cursor, so the server waits" },
      { id: "disk", label: "MongoDB always spills every aggregation to disk" },
    ],
    correctOptionId: "late",
    explanation:
      "An index can only be used at the point where the pipeline reads the collection. Once $group has run, the documents are no longer the original collection documents, and a later $match is a filter on grouped output. The pipeline must process every input document before it can discard anything. If the grouping working set exceeds 100 MB, the stage spills or fails.",
  },
  setup: defaults({ collectionDocs: 40, stagesBeforeMatch: 3, limitEarly: 0, allowDiskUse: 0 }),
  runFor: 8,
  observe: [
    "Documents processed equals the collection size, not the match count.",
    "Peak stage memory crosses the 100 MB limit.",
    "With allowDiskUse off, the operation fails instead of spilling.",
    "Moving $match first reduces both the input and the memory working set.",
  ],
  explain:
    "Stage order is the main performance decision in an aggregation. $match first can use an index and shrink every later stage. $group and $sort are blocking: they need all of their input before they can emit results. A late filter cannot retroactively reduce that work, and a limit after the blocking stage does not reduce it either. The 100 MB per-stage limit turns a large working set into either a disk spill or an error.",
  fix: defaults({ collectionDocs: 20, stagesBeforeMatch: 0, limitEarly: 1, allowDiskUse: 1 }),
  debrief:
    "Move the filter to the front and confirm with explain that the first stage uses an index. Add a limit before the blocking stage when the result allows it. Keep allowDiskUse as a safety valve so a spike spills rather than fails, but treat a spill as a signal that the pipeline is carrying too much data. The tradeoff is that moving a filter can change semantics if the filter depends on a computed field, so verify the output as well as the latency.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An aggregation pipeline is an ordered list of stages. Each stage receives a stream of documents, transforms it, and passes the result to the next stage. The order is executable, not declarative: a filter after a grouping stage filters groups, not the original documents, and it cannot use an index on the original collection.",
  },
  {
    type: "p",
    text: "Some stages are streaming and some are blocking. `$match` and `$project` can process documents one at a time. `$group` and an unindexed `$sort` must see all of their input before they can emit a result. Blocking stages are where memory pressure and disk spills appear.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pipeline starts at a collection or view. If the first stage is a `$match` on an indexed field, the planner can use the index and hand a smaller stream to later stages. If a blocking stage comes first, every document enters that stage regardless of how selective a later filter is.",
  },
  {
    type: "table",
    headers: ["Stage order", "Index use", "What it costs"],
    rows: [
      ["$match first", "Can use a matching index", "Only matching documents enter later stages"],
      ["$group before $match", "Index on the original field is not used", "Every document is grouped before filtering"],
      ["$sort before $match", "Blocking sort of all input", "Memory or disk spill, then filter"],
      ["$limit before $sort", "No index requirement", "Fewer documents enter the blocking stage"],
      ["$limit after $sort", "No index requirement", "Sort still processes the full input"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pipeline p99: the tail including every stage and any spill.",
      "Peak stage memory: the largest working set held by one stage.",
      "Documents processed: the input to the expensive part of the pipeline.",
      "Spilled to disk: data written to temporary files after the memory limit.",
      "Stage order: whether the filter runs before or after the blocking work.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy: the filter is first and the pipeline stays in memory. Apply Late $match and watch documents processed jump to the collection size. Move the filter to the front and compare. Then toggle allowDiskUse on the same late-filter pipeline: it spills instead of failing, but p99 stays high. Use the experiment before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "allowDiskUse is a safety valve",
    body: "MongoDB documents a per-stage memory limit of about 100 MB. With allowDiskUse enabled, a stage that exceeds the limit writes temporary files; with it disabled, the operation raises an error. Spilling keeps the query alive but adds disk I/O, so it can still breach the latency budget. Reducing the input is the primary fix.",
  },
  { type: "sim", simId: "aggregation-perf" },
  { type: "experiment", experimentId: "predict-late-match" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The pipeline ran blocking stages before the filter. The grouping stage received the whole collection, built a working set, and only then did the filter discard most of the groups. Peak memory crossed the 100 MB per-stage limit. With allowDiskUse off, the operation failed; with it on, the stage spilled to disk and p99 stayed above budget because the disk round trip replaced the memory pressure.",
  },
  {
    type: "p",
    text: "Moving the filter to the front changed the economics. The index narrowed the input, the working set stayed small, and the later stages handled far fewer documents. The limit before the blocking stage reduced the working set further. Neither change altered the result because the filter did not depend on a computed field.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Explain or profile output shows a large gap between documents entering the pipeline and documents returned.",
      "The `usedDisk` indicator is set for a stage that spilled to temporary files.",
      "Peak memory for the operation approaches or exceeds the per-stage limit.",
      "Application p99 rises with collection size or result-set size, not with request rate alone.",
      "The same pipeline is fast on a small test collection and slow in production because the working set is larger.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the stage order before changing memory settings. Find how many documents enter each blocking stage and whether a filter could run earlier. Check `usedDisk` and the peak working set. If the filter depends on a computed field, moving it changes semantics; rewrite the pipeline so the filter can still run on the original fields.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Move equality filters into a $match at the start so the planner can use an index.",
      "Keep $sort and $group after the filter that reduces their input.",
      "Move a $limit before the blocking stage only when the result semantics allow it.",
      "Project away fields that later stages do not need.",
      "Enable allowDiskUse as a safety valve, then measure whether the spill meets the latency budget.",
      "If the working set is still too large, change the data model or pre-aggregate rather than raising limits.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An early filter is cheaper but can change results if it depends on a computed field.",
      "An early limit reduces work but may return a different set than a limit after the sort.",
      "allowDiskUse prevents a hard failure but trades memory pressure for disk I/O.",
      "Pre-aggregation lowers query cost but adds write cost and staleness.",
      "A larger per-stage memory allowance hides a bad pipeline instead of fixing it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stage-order",
    question: "How do you find where an aggregation pipeline is spending its time?",
    difficulty: 2,
    hints: [
      "Read the pipeline from the collection forward.",
      "Count documents entering each stage.",
      "Check memory and disk use, not only total latency.",
    ],
    answer:
      "I would read the stage order first and identify the blocking stages. Then I would compare documents entering each stage with documents returned, and check the explain or profile output for peak memory and the `usedDisk` indicator. A late filter that processes the whole collection is a common cause. I would move the filter earlier only after confirming it does not depend on a computed field.",
    followUps: [
      "Which stages are blocking?",
      "What does `usedDisk` tell you?",
      "When does moving a filter change the result?",
    ],
    redFlags: [
      "Raises the memory limit first.",
      "Looks only at the final result count.",
      "Moves a filter without checking semantics.",
    ],
    rubric: [
      "Reads stage order.",
      "Counts documents per stage.",
      "Checks memory and disk.",
      "Verifies semantics before moving a filter.",
    ],
  },
  {
    id: "memory-limit",
    question: "A $group stage exceeds 100 MB. What are your options, and which do you try first?",
    difficulty: 3,
    hints: [
      "Reduce input before raising limits.",
      "allowDiskUse changes failure into spill.",
      "A spill is not free.",
    ],
    answer:
      "First I would reduce the input with an earlier $match or a limit that preserves the result, and project away unneeded fields. If the working set is legitimately large, I would enable allowDiskUse so the stage spills instead of failing, then measure the latency. Raising a memory limit only moves the pressure elsewhere. If the pipeline is still too slow, I would change the data model or pre-aggregate.",
    followUps: [
      "When is a spill acceptable?",
      "What does the per-stage limit protect?",
      "How would you pre-aggregate without breaking freshness?",
    ],
    redFlags: [
      "Raises the limit without reducing input.",
      "Assumes allowDiskUse makes the query fast.",
      "Ignores the result semantics of an early limit.",
    ],
    rubric: [
      "Reduces input first.",
      "Explains allowDiskUse.",
      "Measures spill cost.",
      "Considers pre-aggregation.",
    ],
  },
  {
    id: "late-filter",
    question: "Why can't a $match after $group use an index on the original collection?",
    difficulty: 2,
    hints: [
      "An index is attached to collection documents.",
      "The pipeline has already changed the stream.",
      "The filter sees groups, not source documents.",
    ],
    answer:
      "The index maps collection documents to key values. After $group, the stream contains grouped output, not the original documents, so the later $match is filtering a different shape. The index cannot be applied retroactively. The fix is to move the filter before the grouping stage, or to filter inside the grouping logic when the dependency is intentional.",
    followUps: [
      "When would a filter intentionally run after $group?",
      "What does $match inside $lookup do?",
      "How would you verify the index was used?",
    ],
    redFlags: [
      "Thinks the planner can reorder arbitrary stages.",
      "Adds an index without checking stage order.",
      "Ignores the changed document shape.",
    ],
    rubric: [
      "Explains index attachment to source documents.",
      "Names the changed stream shape.",
      "Moves the filter earlier.",
      "Verifies with explain.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Slow-query dashboards show aggregation stage order and documents processed.",
      "The team knows which pipelines run on large collections.",
      "allowDiskUse policy is explicit for latency-sensitive pipelines.",
      "Pre-aggregation is considered for repeated heavy pipelines.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the stage order before changing memory settings.",
      "Check documents entering each blocking stage.",
      "Check peak memory and `usedDisk`.",
      "Move a filter earlier only if it does not depend on a computed field.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the filter runs first and uses an index.",
      "Confirm p99 and peak memory both fell.",
      "Check whether a spill still occurs at peak.",
      "Record whether the fix was stage order, data shape, or capacity.",
    ],
  },
];

const references = [
  {
    title: "Aggregation Pipeline",
    url: "https://www.mongodb.com/docs/manual/core/aggregation-pipeline/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Pipeline stages, streaming versus blocking behavior, and stage order.",
  },
  {
    title: "Aggregation Pipeline Limits",
    url: "https://www.mongodb.com/docs/manual/core/aggregation-pipeline-limits/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "The 100 MB per-stage memory limit, allowDiskUse, and the usedDisk indicator.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "aggregation-perf": {
      model: aggregationPerfModel,
      presets,
      instructions:
        "Start Healthy, then apply Late $match. Watch documents processed jump to the collection size and memory cross the limit. Move the filter first and compare. Toggle allowDiskUse to see spill versus failure.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Document counts, memory, and latency are teaching values. MongoDB documents a per-stage memory limit of about 100 MB and the allowDiskUse behavior.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-index-design", "mongodb-write-amplification", "mongodb-mongos-routing"],
};
