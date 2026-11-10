import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AGENT_CAPACITY = 300;
const STANDARD_OBJECT_LATENCY = 120;
const EXPRESS_OBJECT_LATENCY = 18;

const params = [
  {
    id: "produceMBps",
    label: "Produce throughput",
    min: 10,
    max: 300,
    step: 10,
    value: 80,
    unit: " MB/s",
    group: "Traffic",
    help: "Bytes per second written by producers. Agents forward batches to object storage; there is no broker-local disk.",
    format: "number" as const,
  },
  {
    id: "batchIntervalMs",
    label: "Batch interval",
    min: 20,
    max: 1_000,
    step: 10,
    value: 250,
    unit: " ms",
    group: "Storage",
    help: "How long an agent waits before writing a batch. Longer batches reduce object requests and cost, but raise the wait for readers.",
    format: "ms" as const,
  },
  {
    id: "storageClass",
    label: "Express object storage",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Storage",
    help: "0 uses standard object storage. 1 uses a low-latency object store such as S3 Express One Zone, which lowers p99 and raises cost.",
    format: "count" as const,
  },
  {
    id: "partitions",
    label: "Partitions",
    min: 100,
    max: 4_000,
    step: 100,
    value: 600,
    unit: "",
    group: "Topic",
    help: "Partitions in the stream. Each partition batches independently, so the partition count multiplies object requests.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  produce: number;
  batchInterval: number;
  express: boolean;
  partitions: number;
  objectRequests: number;
  queueMs: number;
  p99: number;
  costIndex: number;
  agentUtil: number;
}

function compute(p: Params): Computed {
  const produce = Math.max(1, num(p, "produceMBps", 80));
  const batchInterval = Math.max(10, num(p, "batchIntervalMs", 250));
  const express = num(p, "storageClass", 0) >= 1;
  const partitions = Math.max(1, num(p, "partitions", 600));
  const objectRequests = partitions * (1_000 / batchInterval);
  const queueMs = objectRequests > 15_000 ? ((objectRequests - 15_000) / 15_000) ** 2 * 1_200 : 0;
  const p99 =
    10 +
    batchInterval * 0.8 +
    (express ? EXPRESS_OBJECT_LATENCY : STANDARD_OBJECT_LATENCY) +
    queueMs;
  const costIndex = 0.5 + objectRequests / 8_000 + (express ? 1.2 : 0);
  return {
    produce,
    batchInterval,
    express,
    partitions,
    objectRequests,
    queueMs,
    p99,
    costIndex,
    agentUtil: produce / AGENT_CAPACITY,
  };
}

function healthFor(c: Computed): "ok" | "warn" | "crit" {
  if (c.p99 >= 800 || c.objectRequests >= 10_000) return "crit";
  if (c.p99 >= 250 || c.objectRequests >= 4_000) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, flags: SimFrame["flags"]): SimFrame {
  const c = compute(p);
  const health = healthFor(c);
  return {
    t,
    nodes: [
      {
        id: "producers",
        label: "application producers",
        kind: "service",
        health: c.produce > AGENT_CAPACITY ? "crit" : c.produce > AGENT_CAPACITY * 0.8 ? "warn" : "ok",
        utilization: clamp(c.agentUtil),
        sublabel: `${Math.round(c.produce)} MB/s produced`,
        detail: "Producers use the Kafka protocol. The client does not know whether the broker tier keeps data on disk or in object storage.",
        meta: { view: "flow" },
      },
      {
        id: "agents",
        label: "stateless agents",
        kind: "service",
        health,
        utilization: clamp(c.agentUtil),
        sublabel: `${Math.round(c.objectRequests).toLocaleString("en-US")} obj/s · ${Math.round(c.batchInterval)} ms batch`,
        detail: `Agents buffer and batch writes but keep no durable log on local disk. At ${Math.round(c.batchInterval)} ms and ${Math.round(c.partitions).toLocaleString("en-US")} partitions, they issue about ${Math.round(c.objectRequests).toLocaleString("en-US")} object requests per second across the cluster.`,
        meta: {
          batchMs: c.batchInterval,
          objectRequests: c.objectRequests,
          costIndex: c.costIndex,
        },
      },
      {
        id: "storage",
        label: c.express ? "S3 Express One Zone" : "standard object storage",
        kind: "storage",
        health: c.objectRequests >= 10_000 ? "crit" : c.objectRequests >= 4_000 ? "warn" : "ok",
        utilization: clamp(c.objectRequests / 10_000),
        sublabel: `${c.express ? "low-latency class" : "standard class"} · ${Math.round(c.p99)} ms p99`,
        detail: "The object store is the durable log. Durability is high, but each request has a latency and a price; request count is the operational and cost lever.",
        meta: { view: "flow" },
      },
      {
        id: "consumers",
        label: "consumer groups",
        kind: "worker",
        health,
        sublabel: c.p99 >= 800 ? "tail latency above SLO" : "reading through agents",
        detail: "Consumers fetch through agents. Reads may be served from a cache or require an object-store request, so the p99 is sensitive to batching and storage class.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("producers-agents", "producers", "agents", clamp(c.produce / AGENT_CAPACITY), health),
      edge("agents-storage", "agents", "storage", clamp(c.objectRequests / 10_000), health),
      edge("storage-consumers", "storage", "consumers", clamp(c.objectRequests / 10_000), health),
    ],
    metrics: [
      metric("p99-end-to-end", "End-to-end p99", c.p99, " ms", 250, 800, "ms"),
      metric("object-requests", "Object requests", c.objectRequests, " obj/s", 4_000, 10_000, "rps"),
      metric("relative-cost", "Relative storage cost", c.costIndex, "x", undefined, undefined, "number"),
      metric("produce-throughput", "Produce throughput", c.produce, " MB/s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { ...flags, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(c.p99)} ms p99 with ${Math.round(c.objectRequests).toLocaleString("en-US")} object requests/s at a ${Math.round(c.batchInterval)} ms batch interval. Relative cost ${c.costIndex.toFixed(2)}x.`,
  };
}

function seedSeries(frame: SimFrame, c: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.1);
  const seedValues: [string, number, number][] = [
    ["p99-end-to-end", c.p99, 4],
    ["object-requests", c.objectRequests, 20],
    ["relative-cost", c.costIndex, 0.02],
    ["produce-throughput", c.produce, 1],
  ];
  for (const [id, value, amplitude] of seedValues) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 1.8) * amplitude),
    );
  }
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "tail-latency",
    metricId: "p99-end-to-end",
    warn: 250,
    crit: 800,
    title: "Object-storage tail latency breaches the consumer SLO",
    cause:
      "A read waits for a batch to be written or for an object-store request to complete. Longer batch intervals, standard storage class, and request queueing all land in the tail, even when average throughput is fine.",
    fix:
      "Shorten the batch interval, use a low-latency storage class, or serve recent reads from a cache. Do not judge the path by average throughput; compare p99 with the consumer's freshness or request budget.",
    checkFirst: [
      "Split latency into batch wait, metadata lookup, and object read.",
      "Compare p99 with p50 for the same workload.",
      "Check whether the slow consumers are reading old or recent offsets.",
    ],
  },
  {
    id: "object-request-rate",
    metricId: "object-requests",
    warn: 4_000,
    crit: 10_000,
    title: "Object request rate is saturating the storage path",
    cause:
      "Each partition batches independently. More partitions or shorter batches multiply object requests, which raises cost and queueing even when the bytes written are unchanged.",
    fix:
      "Increase batch interval, reduce unnecessary partitions, and consolidate small topics. Measure requests per second alongside bytes per second; object storage prices and limits both.",
    checkFirst: [
      "Compare object requests with bytes written; a high ratio means small batches.",
      "Check for a recent partition increase or a new high-cardinality topic.",
      "Check for consumer groups re-reading cold data.",
    ],
  },
];

export const warpStreamModel: SimModel = {
  id: "streaming-warpstream",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, { seed });
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const c = compute(p);
    const next = buildFrame(p, frame.t, frame.flags);
    next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (c.p99 >= 800 && frame.flags.latencyEvent !== 1) {
      pushEvent(next, {
        id: "object-tail-latency",
        at: frame.t,
        severity: "crit",
        title: "Object-storage latency breaches the SLO",
        detail: `p99 is ${Math.round(c.p99)} ms at a ${Math.round(c.batchInterval)} ms batch interval. Object requests are ${Math.round(c.objectRequests).toLocaleString("en-US")}/s; queueing contributes ${Math.round(c.queueMs)} ms.`,
        nodeId: "storage",
        metricId: "p99-end-to-end",
      });
    }
    next.flags.latencyEvent = c.p99 >= 800 ? 1 : 0;

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `p99 is ${Math.round(c.p99)} ms and p50 is dominated by the ${Math.round(c.batchInterval)} ms batch wait plus the object-store request. Throughput is ${Math.round(c.produce)} MB/s, which says nothing about the tail.`,
    );
    items.push(
      `${Math.round(c.partitions).toLocaleString("en-US")} partitions at one batch per ${Math.round(c.batchInterval)} ms produce about ${Math.round(c.objectRequests).toLocaleString("en-US")} object requests per second.`,
    );
    if (c.batchInterval > 500) {
      items.push("Long batches are the cheap setting: fewer requests and lower cost, but every reader waits for the next batch.");
    }
    if (c.express) {
      items.push("Express object storage cuts the storage portion of p99, but it costs more per byte and still does not remove the batch wait.");
    } else {
      items.push("Standard object storage is cheaper per byte, but its request latency is a large fixed share of p99.");
    }
    if (c.objectRequests >= 10_000) {
      items.push("Request queueing is now a major latency term. Reducing partition count or increasing batch interval lowers it.");
    }
    if (frame.metrics.some((item) => item.id === "p99-end-to-end" && item.value >= 800)) {
      items.push("The incident is a tail-latency incident, not a bandwidth incident. Keep the throughput chart but alert on p99.");
    }
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
    description: "Small partition count, short batches, and a p99 inside the consumer budget.",
    tone: "ok",
    params: defaults({ produceMBps: 80, batchIntervalMs: 100, storageClass: 0, partitions: 300 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More traffic and a longer batch interval push p99 into the warning band.",
    tone: "warn",
    params: defaults({ produceMBps: 120, batchIntervalMs: 250, storageClass: 0, partitions: 600 }),
  },
  {
    id: "failure",
    label: "Tail latency",
    description: "Short batches across thousands of partitions saturate object requests and p99.",
    tone: "crit",
    params: defaults({ produceMBps: 160, batchIntervalMs: 80, storageClass: 0, partitions: 2_400 }),
  },
  {
    id: "batch-optimized",
    label: "Cost-optimized batching",
    description: "One-second batches cut requests and cost, but readers wait for the batch.",
    tone: "crit",
    params: defaults({ produceMBps: 120, batchIntervalMs: 1_000, storageClass: 0, partitions: 600 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Short batches on a low-latency storage class restore the p99 at a higher cost.",
    tone: "ok",
    params: defaults({ produceMBps: 120, batchIntervalMs: 200, storageClass: 1, partitions: 600 }),
  },
];

const experiment: Experiment = {
  id: "predict-batch-tradeoff",
  title: "Predict what a one-second batch buys",
  simId: "warpstream",
  question:
    "You raise the batch interval from 200 ms to 1,000 ms on standard object storage with 600 partitions. Object requests fall by roughly 80% and the relative cost drops. What happens to end-to-end p99?",
  prediction: {
    options: [
      { id: "improves", label: "p99 improves because there are fewer requests" },
      { id: "flat", label: "p99 stays the same because throughput is unchanged" },
      { id: "worse", label: "p99 rises above the SLO because readers wait for the batch" },
      { id: "unbounded", label: "p99 becomes unbounded until the next topic compaction" },
    ],
    correctOptionId: "worse",
    explanation:
      "The batch interval is a deliberate delay. A reader that arrives just after a batch closes waits almost the full interval for the next object to be written. Fewer, larger requests reduce cost and request-rate pressure, but they add a predictable wait to the tail. At 1,000 ms the batch wait alone is large enough to breach a sub-second consumer SLO on standard storage. The fix is to shorten the batch, use a low-latency class, or serve recent data from a cache.",
  },
  setup: defaults({ produceMBps: 120, batchIntervalMs: 1_000, storageClass: 0, partitions: 600 }),
  runFor: 20,
  observe: [
    "Object requests fall to about 600 per second and the relative cost index drops.",
    "End-to-end p99 rises to roughly 930 ms.",
    "Throughput is unchanged; only the wait and the request count moved.",
    "Shortening the batch or using express storage trades cost back for latency.",
  ],
  explain:
    "Object-storage streaming replaces broker-local disk with remote objects. The architecture scales cheaply and durably, but it batches writes to amortize object requests. Batching is the main latency knob, and partition count is the main request multiplier. The right setting depends on whether the consumer is a batch job that cares about throughput or a synchronous path that cares about p99.",
  fix: defaults({ produceMBps: 120, batchIntervalMs: 200, storageClass: 1, partitions: 600 }),
  debrief:
    "The fix lowers p99 to about 190 ms by shortening the batch and using a low-latency object class. The relative cost index rises from about 0.6x to about 2.1x in this illustrative model. That is the trade in one line: you can buy tail latency with request efficiency or buy request efficiency with latency, but the storage round trip does not disappear.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "WarpStream is a Kafka-compatible streaming service that keeps the durable log in object storage instead of on broker disks. Producers and consumers use the Kafka protocol and connect to stateless agents. The agents buffer, batch, and write objects; the metadata service tracks where each partition's data lives. There is no local log to replicate between brokers, because the object store is the replication layer.",
  },
  {
    type: "p",
    text: "The architecture changes the cost and latency profile. Object storage is cheap, durable, and effectively unbounded, and agents can be replaced without copying a disk. But every read or write is an object request with its own latency and price. Batching amortizes requests, which lowers cost and raises the wait for the next batch. Partition count multiplies requests because each partition batches independently. A design that is excellent for a nightly analytics consumer can be wrong for a request path with a 200 ms budget.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, stateless agent, object storage, and consumer through an agent. The metadata service is off the data path for large reads in the normal case, but it is consulted for partition discovery and object lookup. The object store provides durability; the agent tier provides protocol compatibility and caching. There is no broker-local page cache to tune, and no inter-broker replication traffic to watch.",
  },
  {
    type: "table",
    headers: ["Property", "Broker-local disk", "Object-storage streaming"],
    rows: [
      ["Durability", "Replication across brokers", "Object-store durability and versioning"],
      ["Read latency", "Page cache or local disk", "Object request plus any batch wait"],
      ["Scaling", "Move partitions and copy data", "Add or replace stateless agents"],
      ["Cost shape", "Provisioned disks and brokers", "Storage bytes plus request count"],
      ["Tail behavior", "Queueing and disk contention", "Batch interval plus object latency"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses illustrative values: 10 to 300 MB/s of produce traffic, 20 to 1,000 ms batches, and 100 to 4,000 partitions. The 120 ms and 18 ms object latencies and the relative cost index are teaching values, not measured S3 or WarpStream benchmarks. The relationships are the lesson: requests scale with partitions divided by batch interval, and p99 includes the batch wait.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "End-to-end p99: batch wait plus object-store latency plus queueing at high request rates.",
      "Object requests per second: partitions multiplied by the number of batches per second.",
      "Relative storage cost: an illustrative index that rises with requests and with the low-latency storage class.",
      "Produce throughput in MB/s, which can look healthy while p99 is failing.",
      "A flow view from producers through stateless agents to object storage and consumers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Tail latency. Compare p99 with produce throughput, then apply Cost-optimized batching and watch the trade reverse. Finish with Recovery and note the cost index change.",
  },
  { type: "sim", simId: "warpstream" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset combined 2,400 partitions with an 80 ms batch interval, which produced about 30,000 object requests per second. Request queueing added roughly 1,200 ms, the standard storage round trip added 120 ms, and p99 reached about 1,394 ms. Produce throughput was only 160 MB/s, well below what the agent tier could move. The path was not throughput-bound. It was bound by the number of small object operations and the tail of the object store.",
  },
  {
    type: "p",
    text: "The cost-optimized preset went the other way: 600 partitions and a 1,000 ms batch reduced object requests to 600 per second and the relative cost index to about 0.6x, but p99 rose to about 930 ms because every reader waits for the next batch. Recovery used a 200 ms batch on a low-latency object class, which brought p99 to about 190 ms and raised the cost index to about 2.1x. Neither setting is universally right; the consumer's latency budget decides.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Object request rate and bytes per request, split by partition and by operation type.",
      "End-to-end p99 and p50 for produce and consume, separated into batch wait, metadata, and object read.",
      "Agent CPU, memory, and cache hit rate; agents are stateless but not free.",
      "Object-store throttling, slow-down responses, and cross-region or cross-AZ request paths.",
      "Cost allocation by storage bytes, request count, and storage class.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare p99 with p50 and with throughput. If p99 is high while bytes per second are normal, look at batch interval, request count, and storage class. Check whether the slow reads are recent or historical before changing the whole cluster.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure p99 by operation and split it into batch wait, metadata lookup, and object read.",
      "Reduce the batch interval for latency-sensitive topics; accept the higher request and cost profile.",
      "Use a low-latency object class for the hot path and keep cold data on standard storage.",
      "Reduce partition count where it no longer buys consumer parallelism; each partition multiplies requests.",
      "Add a recent-data cache at the agent or consumer layer for repeated reads.",
      "Isolate latency-sensitive topics from batch workloads so one batch interval does not serve both.",
      "Re-test at peak with the real object size and request mix, not a synthetic small-object benchmark.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer batches lower request cost and raise tail latency; shorter batches do the reverse.",
      "A low-latency object class improves p99 but costs more per byte and may have its own availability constraints.",
      "More partitions add parallelism and request overhead; fewer partitions save requests but can cap consumers.",
      "Stateless agents simplify scaling and failover, but they add a network hop and depend on object-store availability.",
      "Object storage provides durability without inter-broker replication, but the provider's outage domain becomes your outage domain.",
      "The architecture fits throughput-oriented and spiky workloads better than strict low-latency request paths.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "object-storage-architecture",
    question:
      "Explain how a Kafka-compatible service can store its log in object storage, and what changes for scaling and failover.",
    difficulty: 3,
    hints: [
      "The object store is the replication layer.",
      "Agents hold no durable partition data.",
    ],
    answer:
      "Producers write to stateless agents, which batch records into objects and record the object locations in a metadata service. Consumers read through agents, which fetch the object or serve it from cache. Because the object store replicates the data, the agent tier does not need to copy partitions between brokers during scaling or failover. You can add or replace agents without moving a terabyte of log data. The costs are a network hop, dependency on object-store latency and availability, and a metadata service that must be highly available. Durability now comes from the object store's model, not from broker replication.",
    followUps: [
      "What is on the metadata path?",
      "What happens during an object-store outage?",
      "How does consumer isolation differ from classic Kafka?",
    ],
    redFlags: [
      "Claims there is no metadata service.",
      "Assumes object storage is always lower latency.",
      "Ignores the provider outage domain.",
    ],
    rubric: [
      "Places data in objects and metadata separately.",
      "Explains stateless scaling.",
      "Names latency and availability costs.",
      "Contrasts with broker replication.",
    ],
  },
  {
    id: "tail-latency-diagnosis",
    question:
      "Throughput is normal but p99 consume latency is above the SLO. How do you diagnose an object-storage streaming path?",
    difficulty: 3,
    hints: [
      "Split batch wait from object request time.",
      "Check request count and recent versus historical reads.",
    ],
    answer:
      "I would split the latency into the wait for the next batch, metadata lookup, and the object read. Then I would compare p99 with p50 and check whether the slow reads are recent, which points at batch interval, or historical, which points at object-store or cache behavior. I would also check object requests per second and bytes per request: a high request count with small objects suggests too many partitions or too-short batches. Finally I would compare the storage class and the client region with the bucket region. Throughput being normal only rules out bandwidth saturation.",
    followUps: [
      "Which change would you try first for recent reads?",
      "How would a cache change the measurement?",
      "What does a high request-to-byte ratio tell you?",
    ],
    redFlags: [
      "Adds brokers without measuring request rate.",
      "Assumes average latency represents the SLO.",
      "Ignores batch interval.",
    ],
    rubric: [
      "Separates batch, metadata, and object time.",
      "Uses p99 and request count.",
      "Distinguishes recent from historical reads.",
      "Proposes a bounded experiment.",
    ],
  },
  {
    id: "when-not-object-storage",
    question:
      "When would you not choose object-storage streaming for a Kafka workload?",
    difficulty: 3,
    hints: [
      "Think about strict synchronous latency and provider boundaries.",
      "Object storage is a shared dependency.",
    ],
    answer:
      "I would avoid it for a synchronous request path with a tight p99 budget, especially when the consumer must read the newest record immediately. The batch interval and object round trip put a floor under tail latency. I would also be cautious when the workload cannot tolerate the object provider's outage domain, when data residency or network egress rules forbid the path, or when the team needs broker-level tuning and inspection. For throughput-oriented analytics, replay, and spiky ingestion, the cost and elasticity often win. The decision should be made per topic and per consumer SLO, not once for the whole platform.",
    followUps: [
      "How would you isolate a latency-sensitive topic?",
      "What does the cost model look like at low volume?",
      "How do you test the provider outage case?",
    ],
    redFlags: [
      "Treats object storage as universally cheaper.",
      "Ignores the consumer SLO.",
      "Has no isolation plan.",
    ],
    rubric: [
      "Names the latency floor.",
      "Considers provider and residency risk.",
      "Matches architecture to workload.",
      "Proposes isolation or a hybrid.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each topic has a consumer latency budget and a batch interval chosen for it.",
      "Dashboards show p99, p50, object requests per second, and bytes per request.",
      "Object-store region, storage class, and request throttling are monitored.",
      "A load test covers the real partition count and object size.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split p99 into batch wait, metadata, and object read before changing capacity.",
      "Check whether slow reads are recent or historical.",
      "Reduce request pressure by increasing batch interval or pausing non-critical partitions.",
      "Verify that the object store is not throttling or degraded.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Set separate batch policies for latency-sensitive and throughput topics.",
      "Right-size partitions and remove unused topics.",
      "Revisit the storage class against the measured p99 and cost.",
      "Re-run the peak test with the real request mix.",
    ],
  },
];

const references = [
  {
    title: "WarpStream architecture overview",
    url: "https://docs.warpstream.com/warpstream/overview/architecture",
    publisher: "WarpStream",
    kind: "docs" as const,
    note: "Stateless agents, object storage, and metadata service design.",
  },
  {
    title: "WarpStream write path",
    url: "https://docs.warpstream.com/warpstream/overview/architecture/write-path",
    publisher: "WarpStream",
    kind: "docs" as const,
    note: "Batching and direct writes to object storage without a local WAL.",
  },
  {
    title: "WarpStream low-latency clusters with S3 Express One Zone",
    url: "https://docs.warpstream.com/warpstream/kafka/advanced-agent-deployment-options/low-latency-clusters/s3-express",
    publisher: "WarpStream",
    kind: "docs" as const,
    note: "Lower-latency object storage and its cost tradeoff.",
  },
  {
    title: "Amazon S3 performance best practices",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Request rate, object size, and latency considerations for S3 workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    warpstream: {
      model: warpStreamModel,
      presets,
      instructions:
        "Start Healthy, apply Tail latency, then Cost-optimized batching. Watch p99 and object requests move in opposite directions before applying Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Object latency, capacity, and cost index are teaching values, not vendor benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-kafka-partitions",
    "streaming-object-storage-latency",
    "streaming-partition-count",
    "streaming-retention",
  ],
};
