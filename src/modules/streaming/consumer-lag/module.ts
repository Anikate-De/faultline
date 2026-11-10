import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_LAG = 5_000_000;
const MAX_CATCH_UP = 86_400;
const JITTER = 0.005;

const params = [
  {
    id: "produceRate",
    label: "Production rate",
    min: 5_000,
    max: 40_000,
    step: 1_000,
    value: 10_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records appended to the topic per second. It sets both the load and the age of the oldest unprocessed record.",
    format: "rps" as const,
  },
  {
    id: "consumers",
    label: "Consumers",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Consumers",
    help: "Members in the group. Each owns one partition, so the count only helps up to the partition count.",
    format: "count" as const,
  },
  {
    id: "consumerRate",
    label: "Consumer throughput",
    min: 1_000,
    max: 8_000,
    step: 500,
    value: 3_000,
    unit: " rec/s",
    group: "Consumers",
    help: "Records per second one consumer processes. Group capacity is consumers times this rate.",
    format: "rps" as const,
  },
  {
    id: "initialLag",
    label: "Starting backlog",
    min: 0,
    max: 5_000_000,
    step: 100_000,
    value: 0,
    unit: " rec",
    group: "Backlog",
    help: "Lag at the start of the run. It is applied when a preset or the simulation loads.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flagNumber(flags: SimFrame["flags"], id: string, fallback = 0): number {
  const value = flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  lag: number;
  produceRate: number;
  capacity: number;
  consumedRate: number;
  netDrain: number;
  catchUpSeconds: number;
  lagAgeSeconds: number;
  shortfall: number;
}

function compute(p: Params, lag: number, seconds: number, jitter: number): Values {
  const produceRate = Math.max(1, num(p, "produceRate", 10_000) * jitter);
  const capacity = Math.max(0, Math.round(num(p, "consumers", 6))) * Math.max(0, num(p, "consumerRate", 3_000));
  const netDrain = capacity - produceRate;
  const catchUpSeconds =
    lag <= 0
      ? 0
      : netDrain > 0
        ? Math.min(MAX_CATCH_UP, lag / netDrain)
        : MAX_CATCH_UP;
  const consumedRate = Math.min(capacity, produceRate + lag / Math.max(0.001, seconds));
  return {
    lag,
    produceRate,
    capacity,
    consumedRate,
    netDrain,
    catchUpSeconds,
    lagAgeSeconds: lag / produceRate,
    shortfall: Math.max(0, produceRate - capacity),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worstHealth(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function buildFrame(t: number, values: Values, flags: SimFrame["flags"]): SimFrame {
  const fill = clamp(values.lag / MAX_LAG) * 100;
  const consumerHealth = worstHealth(
    worstHealth(healthFor(values.catchUpSeconds, 300, 1_200), healthFor(values.lagAgeSeconds, 600, 1_800)),
    healthFor(values.shortfall, 500, 2_000),
  );
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: "ok",
        utilization: 0.6,
        throughput: values.produceRate,
        sublabel: `${Math.round(values.produceRate).toLocaleString("en-US")} rec/s`,
        meta: { view: "queue" },
      },
      {
        id: "topic",
        label: "orders.events",
        kind: "queue",
        health: "ok",
        utilization: clamp(values.lag / MAX_LAG),
        throughput: values.produceRate,
        capacity: MAX_LAG,
        sublabel: `${Math.round(values.lag).toLocaleString("en-US")} records behind`,
        detail: `Lag is the log end offset minus the group's committed offset. It is a count; the freshness impact depends on production rate and how fast the group can drain it.`,
        meta: { depth: values.lag, fill },
      },
      {
        id: "consumer",
        label: "orders-consumers",
        kind: "worker",
        health: consumerHealth,
        utilization: values.capacity > 0 ? clamp(values.consumedRate / values.capacity) : 0,
        throughput: values.consumedRate,
        capacity: values.capacity,
        sublabel: `${Math.round(values.consumedRate).toLocaleString("en-US")} rec/s processed`,
        detail:
          values.netDrain > 0
            ? `Capacity exceeds production by ${Math.round(values.netDrain).toLocaleString("en-US")} rec/s. At this rate the backlog drains in about ${values.catchUpSeconds.toFixed(0)} seconds.`
            : `Production exceeds capacity by ${Math.round(values.shortfall).toLocaleString("en-US")} rec/s. The backlog grows; at current rates it never catches up.`,
        meta: {
          capacity: values.capacity,
          netDrain: values.netDrain,
          catchUp: values.catchUpSeconds,
        },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", 0.75, "ok"),
      edge("topic-consumer", "topic", "consumer", clamp(values.consumedRate / Math.max(1, values.produceRate)), consumerHealth),
    ],
    metrics: [
      metric("queueDepth", "Buffered records", values.lag, " records", undefined, undefined, "count"),
      metric("consumer-lag", "Consumer lag", values.lag, " records", undefined, undefined, "count"),
      metric("catch-up-time", "Time to catch up", values.catchUpSeconds, " s", 300, 1_200, "count"),
      metric("lag-age", "Age of oldest record", values.lagAgeSeconds, " s", 600, 1_800, "count"),
      metric("drain-shortfall", "Capacity shortfall", values.shortfall, " rec/s", 500, 2_000, "rps"),
      metric("consume-capacity", "Consumer capacity", values.capacity, " rec/s", undefined, undefined, "rps"),
      metric("drain-rate", "Net drain rate", Math.max(0, values.netDrain), " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      lag: values.lag,
      catchUp: values.catchUpSeconds,
      shortfall: values.shortfall,
    },
    summary:
      values.shortfall > 0
        ? `Lag is ${Math.round(values.lag).toLocaleString("en-US")} records and growing by ${Math.round(values.shortfall).toLocaleString("en-US")} rec/s; it never catches up at current rates.`
        : values.lag > 0
          ? `Lag is ${Math.round(values.lag).toLocaleString("en-US")} records; at ${Math.round(values.netDrain).toLocaleString("en-US")} rec/s net drain it clears in ${Math.round(values.catchUpSeconds).toLocaleString("en-US")}s.`
          : `The group is current at ${Math.round(values.produceRate).toLocaleString("en-US")} rec/s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.3);
  const series: [string, number][] = [
    ["queueDepth", values.lag],
    ["consumer-lag", values.lag],
    ["catch-up-time", values.catchUpSeconds],
    ["lag-age", values.lagAgeSeconds],
    ["drain-shortfall", values.shortfall],
    ["consume-capacity", values.capacity],
    ["drain-rate", Math.max(0, values.netDrain)],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

export const consumerLagModel: SimModel = {
  id: "streaming-consumer-lag",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 1, 1);
    const frame = buildFrame(0, values, {});
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const jitter = 1 + rng.between(-JITTER, JITTER);
    const startingLag = Math.max(0, Math.min(MAX_LAG, num(p, "initialLag", 0)));
    const fresh = frame.flags.initialLag === undefined;
    const previousLag = fresh ? startingLag : Math.max(0, flagNumber(frame.flags, "lag"));
    const produceRate = Math.max(1, num(p, "produceRate", 10_000) * jitter);
    const capacity = Math.max(0, Math.round(num(p, "consumers", 6))) * Math.max(0, num(p, "consumerRate", 3_000));
    const lag = clamp(previousLag + (produceRate - capacity) * seconds, 0, MAX_LAG);
    const values = compute(p, lag, seconds, jitter);
    const t = frame.t + seconds;
    const result = buildFrame(t, values, frame.flags);
    result.series = frame.series;
    result.events = frame.events;

    if (values.shortfall > 0 && frame.flags.neverDrains !== 1) {
      pushEvent(result, {
        id: "lag-never-drains",
        at: t,
        severity: "crit",
        title: "The group cannot catch up at current rates",
        detail: `Production is ${Math.round(values.produceRate).toLocaleString("en-US")} rec/s and capacity is ${Math.round(values.capacity).toLocaleString("en-US")} rec/s. The backlog grows by ${Math.round(values.shortfall).toLocaleString("en-US")} rec/s, so time-to-catch-up is unbounded.`,
        nodeId: "consumer",
        metricId: "drain-shortfall",
      });
      result.flags.neverDrains = 1;
    }
    if (values.catchUpSeconds >= 1_200 && frame.flags.catchUpEvent !== 1) {
      pushEvent(result, {
        id: "catch-up-slo-breach",
        at: t,
        severity: "warn",
        title: "Time-to-catch-up exceeds the freshness objective",
        detail: `The backlog would take ${values.catchUpSeconds >= MAX_CATCH_UP ? "longer than the modeled one-day cap" : `${Math.round(values.catchUpSeconds)} seconds`} to drain at the current net rate. The message count alone did not show this.`,
        nodeId: "consumer",
        metricId: "catch-up-time",
      });
      result.flags.catchUpEvent = 1;
    }

    result.flags.initialLag = startingLag;
    for (const item of result.metrics) recordSeries(result, item.id, item.value);
    return result;
  },
  thresholds: [
    {
      id: "catch-up-time",
      metricId: "catch-up-time",
      warn: 300,
      crit: 1_200,
      title: "Time-to-catch-up is beyond the freshness objective",
      cause:
        "The backlog divided by the net drain rate is the time until the group catches up. Net drain is consumer capacity minus production rate. If capacity is at or below production, the backlog never drains and the metric is capped at the modeled maximum.",
      fix:
        "Add consumer capacity up to the partition count, reduce the production rate, or shed work the consumer does not need to process. Verify that capacity is above production after the change; more consumers cannot fix a downstream bottleneck.",
      checkFirst: [
        "Compare consumer capacity with production rate, not lag count with a threshold.",
        "Check whether the group already has one consumer per partition.",
        "Check whether processing time or a downstream call, not fetch rate, is the limit.",
      ],
    },
    {
      id: "lag-age",
      metricId: "lag-age",
      warn: 600,
      crit: 1_800,
      title: "The oldest unprocessed record is too old",
      cause:
        "Lag divided by production rate approximates the age of the oldest record still waiting. A small count on a low-traffic topic can be older than a large count on a high-traffic one.",
      fix:
        "Use the product's freshness objective: how old may the oldest unprocessed event be? Reduce lag, increase drain rate, or move the freshness-sensitive work to a separate consumer path.",
      checkFirst: [
        "Check the timestamp of the oldest unprocessed record, not only the offset difference.",
        "Check whether the topic's records are event-time or processing-time sensitive.",
        "Check whether all partitions contribute to the oldest record or only one.",
      ],
    },
    {
      id: "drain-shortfall",
      metricId: "drain-shortfall",
      warn: 500,
      crit: 2_000,
      title: "Consumer capacity is below the production rate",
      cause:
        "When production exceeds capacity, the backlog grows without bound. Adding consumers helps only while partitions are unassigned and the downstream can absorb the extra write rate. A slow single partition cannot be split by more members.",
      fix:
        "Add consumers, reduce per-record processing cost, or lower production. If one partition is the bottleneck, change the key or the workload rather than adding members.",
      checkFirst: [
        "Check per-partition lag to find a hot or slow partition.",
        "Check consumer CPU, downstream latency, and poison records.",
        "Check whether the group has more consumers than partitions.",
      ],
    },
  ],
  insights: (frame, p) => {
    const lag = Math.max(0, flagNumber(frame.flags, "lag"));
    const produce = Math.max(1, num(p, "produceRate", 10_000));
    const capacity = Math.max(0, Math.round(num(p, "consumers", 6))) * Math.max(0, num(p, "consumerRate", 3_000));
    const net = capacity - produce;
    const items: string[] = [];
    items.push(
      `Lag is ${Math.round(lag).toLocaleString("en-US")} records at ${Math.round(produce).toLocaleString("en-US")} rec/s produced and ${Math.round(capacity).toLocaleString("en-US")} rec/s of capacity.`,
    );
    items.push(
      net > 0
        ? `Net drain is ${Math.round(net).toLocaleString("en-US")} rec/s, so the backlog clears in about ${Math.round(lag / net)} seconds.`
        : `Net drain is zero or negative; the group cannot catch up at these rates, regardless of the lag count.`,
    );
    items.push(`The approximate age of the oldest unprocessed record is ${(lag / produce).toFixed(0)} seconds; that is the freshness signal, not the count.`);
    items.push("A lag alert on message count alone pages on volume changes and misses a permanent backlog on a high-traffic topic.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No backlog, 10k rec/s produced, and 18k rec/s of consumer capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A two-million backlog drains at only 2k rec/s above production; catch-up takes about 17 minutes.",
    tone: "warn",
    params: defaults({ produceRate: 25_000, consumers: 9, initialLag: 2_000_000 }),
    elapsed: 60,
  },
  {
    id: "failure",
    label: "Never catches up",
    description: "Two million records behind, 20k rec/s produced, and only 12k rec/s of capacity.",
    tone: "crit",
    params: defaults({ produceRate: 20_000, consumers: 4, initialLag: 2_000_000 }),
  },
  {
    id: "recovery",
    label: "Ten consumers",
    description: "The same backlog and production with 30k rec/s of capacity; it drains in about three minutes.",
    tone: "ok",
    params: defaults({ produceRate: 20_000, consumers: 10, initialLag: 2_000_000 }),
  },
  {
    id: "one-more",
    label: "Add one consumer",
    description: "Five consumers provide 15k rec/s against 20k produced; one more member is still below production.",
    tone: "crit",
    params: defaults({ produceRate: 20_000, consumers: 5, initialLag: 2_000_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-lag-severity",
  title: "Predict whether two million is bad",
  simId: "consumer-lag",
  question:
    "The group is two million records behind. Production is 20k rec/s and the group processes 12k rec/s. How bad is that lag?",
  prediction: {
    options: [
      { id: "count", label: "Bad, because two million is a large number" },
      { id: "never", label: "Unbounded: production is above capacity, so the backlog never drains" },
      { id: "soon", label: "Fine, because consumers always catch up after a burst" },
      { id: "age", label: "Fine, because the age of the oldest record is the only signal" },
    ],
    correctOptionId: "never",
    explanation:
      "Lag count alone says nothing about direction. The group processes 12k rec/s but 20k arrive, so the backlog grows by 8k every second. Time-to-catch-up is infinite at these rates. The same two-million backlog would drain in about three minutes if the group had 30k rec/s of capacity. The count matters only with production rate and processing rate.",
  },
  setup: defaults({ produceRate: 20_000, consumers: 4, initialLag: 2_000_000 }),
  runFor: 30,
  observe: [
    "Lag grows from two million to about 2.24 million over 30 seconds.",
    "Time-to-catch-up sits at the modeled cap because net drain is negative.",
    "Capacity shortfall is 8k rec/s; the gap is a rate, not a count.",
    "The age of the oldest record grows more slowly than the count, but in the wrong direction.",
  ],
  explain:
    "Time-to-catch-up is backlog divided by consumer capacity minus production rate. When capacity is below production, the denominator is negative and the backlog never clears. Adding one consumer moves capacity from 12k to 15k, still below 20k, so it only slows the growth. Adding six consumers moves capacity to 30k, giving a 10k rec/s net drain and a finite catch-up time. The right alert is on the time-to-catch-up and the age of the oldest record, with the count as context.",
  fix: defaults({ produceRate: 20_000, consumers: 10, initialLag: 2_000_000 }),
  debrief:
    "Ten consumers provide 30k rec/s against 20k produced. The two-million backlog drains at 10k rec/s, so it clears in about 200 seconds. At 60 seconds it is still 1.4 million, but the trend and the catch-up time both show recovery. The count alone would have looked alarming for the entire drain; the time-to-catch-up is what tells you whether the system is getting better.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Consumer lag is the distance between the log end offset and a consumer group's committed offset. If the log has written records through offset 10,000 and the group has committed offset 8,000, the lag is 2,000 records. It is a position, not a duration. The same count can mean a healthy group on a high-traffic topic or an unrecoverable backlog on a low-capacity one.",
  },
  {
    type: "p",
    text: "Three signals describe lag. The count is how many records are waiting. Time-to-catch-up is the count divided by the net drain rate, which is consumer capacity minus production rate. Lag age is the count divided by the production rate, an estimate of how old the oldest unprocessed record is. The count is easy to graph and easy to misread; the other two connect lag to a user-facing freshness objective, expressed as a service level objective (SLO).",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer to partition log to consumer group. The broker tracks the log end offset; the group tracks its committed offset per partition. Lag is their difference. Consumer capacity is members times per-member processing rate, capped by the partition count because one partition is assigned to one member per group. If production is above that capacity, lag grows no matter how large the backlog already is. If capacity is above production, the backlog drains at the difference.",
  },
  {
    type: "table",
    headers: ["Signal", "Formula", "What it tells you"],
    rows: [
      ["Lag count", "log end offset - committed offset", "Volume waiting; no direction or urgency by itself"],
      ["Time-to-catch-up", "lag / (capacity - production)", "Whether the backlog clears and how long it takes"],
      ["Lag age", "lag / production rate", "Approximate age of the oldest unprocessed record"],
      ["Capacity shortfall", "max(0, production - capacity)", "Whether the backlog is growing without bound"],
      ["Per-partition lag", "per partition offsets", "Whether one partition or member is the bottleneck"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 5k to 40k records per second, 2 to 12 consumers at 1k to 8k records per second each, and a starting backlog of up to five million records. Time-to-catch-up is capped at one day so the chart stays finite; reaching the cap means the group does not catch up at current rates. These are illustrative teaching values, not Kafka limits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Consumer lag in records, with no warning line: count alone is not the SLO.",
      "Time-to-catch-up in seconds, with warning at five minutes and critical at twenty.",
      "Age of the oldest record, an estimate from lag divided by production rate.",
      "Capacity shortfall in records per second when production exceeds processing.",
      "A queue view with the producer, the topic backlog, and the consumer group.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Never catches up. Run the guided experiment before changing sliders: decide whether two million is bad. Then compare Add one consumer with Ten consumers and watch time-to-catch-up, not the count, decide the outcome.",
  },
  { type: "sim", simId: "consumer-lag" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The group started two million records behind. Production was 20,000 per second and four consumers processed 12,000, so the backlog grew by 8,000 every second. After 30 seconds it was about 2.24 million. Time-to-catch-up sat at the modeled one-day cap because the net drain was negative: no amount of waiting would clear it. The consumer node turned critical even though the topic and producer were healthy.",
  },
  {
    type: "p",
    text: "Adding one consumer moved capacity from 12,000 to 15,000, still below production; the backlog kept growing, only more slowly. Ten consumers provided 30,000 per second, a net drain of 10,000. The two-million backlog then cleared in about 200 seconds. At 60 seconds it was still 1.4 million, but time-to-catch-up was falling. The lag count looked bad throughout the recovery; the derivative and the catch-up time showed the truth.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer lag per partition and per member, plus records-consumed-rate and production rate.",
      "Estimated time lag or time-to-catch-up from the monitoring system, not only records-lag-max.",
      "Consumer processing time, downstream latency, and error rate, which set the real capacity.",
      "Partition assignment: idle members when consumers exceed partitions, hot partitions when one key dominates.",
      "Age of the oldest unprocessed record, sampled from the record timestamp.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare consumer capacity with production rate before looking at the lag count. Then check per-partition lag, because one slow partition can hold back the group. Confirm whether the limit is CPU, a downstream call, or a poison record, and check whether the group already has one consumer per partition.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Compute net drain: capacity minus production. If it is zero or negative, the backlog cannot clear.",
      "Find the bottleneck: partition count, consumer CPU, downstream latency, or a single slow partition.",
      "Add consumers only up to the partition count and only if the downstream can absorb the extra writes.",
      "Reduce processing cost or batch size, or move slow work off the consume path.",
      "If one partition is hot or slow, change the key distribution or isolate that workload.",
      "Track time-to-catch-up and lag age during the drain; the count can stay high while recovery is working.",
      "Set the alert on the freshness objective, with count as context, not as the page trigger.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More consumers increase cost and downstream write pressure; they do nothing beyond the partition count or when the downstream is the bottleneck.",
      "A larger backlog can be drained faster only by spare capacity; running consumers hot all the time costs money for a burst that may never come.",
      "Alerting on time-to-catch-up catches real freshness risk but needs a reliable production-rate estimate; rate noise can flap the alert.",
      "Alerting on lag count is simple but pages on traffic spikes and misses a permanent backlog on a fast topic.",
      "Shedding or skipping records reduces lag and loses data; it needs a product decision, not an operator improvisation.",
      "Reducing retention shortens replay and storage cost but can make a backlog unrecoverable.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "lag-severity",
    question:
      "Consumer lag is two million records. Is that bad? Walk me through how you decide.",
    difficulty: 2,
    hints: [
      "The count is a position, not a rate.",
      "Compare consumer capacity with production rate.",
    ],
    answer:
      "I would not answer from the count. I would get the production rate, the group's processing rate, and the per-partition lag. Net drain is capacity minus production. If capacity is above production, the backlog drains and the question is how long: lag divided by net drain. If capacity is below production, the backlog never clears at current rates. I would also estimate lag age as lag divided by production rate and compare it with the freshness objective. Two million on a 20k/s topic is about 100 seconds of data; whether that is bad depends on the SLO and on whether the gap is closing.",
    followUps: [
      "What would make a two-million backlog acceptable?",
      "How do you tell whether one partition is the bottleneck?",
      "Which signal would you page on?",
    ],
    redFlags: [
      "Answers from the count alone.",
      "Assumes consumers always catch up.",
      "Ignores per-partition distribution.",
    ],
    rubric: [
      "Computes net drain from rates.",
      "Uses time-to-catch-up and age.",
      "Checks per-partition lag.",
      "Connects the answer to a freshness objective.",
    ],
  },
  {
    id: "lag-alert",
    question:
      "Design an alert for consumer lag that pages only when users are at risk.",
    difficulty: 3,
    hints: [
      "Count thresholds fire on traffic changes.",
      "Freshness is a time property.",
    ],
    answer:
      "I would alert on time-to-catch-up and the age of the oldest unprocessed record, both tied to the product's freshness objective. Time-to-catch-up needs production rate and consumer capacity; age needs the oldest record timestamp. I would use a sustained window so a brief burst does not page, and I would keep the count as context on the dashboard. I would also add a separate alert for capacity below production, because that condition will not self-heal. Per-partition lag and consumer processing time would be diagnostic panels, not page triggers.",
    followUps: [
      "How do you estimate production rate reliably?",
      "What window would you use, and why?",
      "How would you avoid flapping when a consumer restarts?",
    ],
    redFlags: [
      "Pages on a fixed message count.",
      "Ignores production rate.",
      "Has no sustained window.",
    ],
    rubric: [
      "Alerts on a time or age objective.",
      "Uses production and processing rates.",
      "Adds a sustained window.",
      "Separates page signals from diagnostics.",
    ],
  },
  {
    id: "burst-or-gap",
    question:
      "A lag spike follows a traffic burst. How do you tell whether it will drain or whether you have a permanent capacity gap?",
    difficulty: 3,
    hints: [
      "The sign of capacity minus production decides the direction.",
      "A burst changes production for a short window, not capacity.",
    ],
    answer:
      "I would plot production rate, consumer capacity, and lag on the same time axis. After the burst, if production returns below capacity, the backlog drains and the time-to-catch-up falls; that is a temporary burst. If production stays at or above capacity, the backlog is flat or growing and the gap is structural. I would confirm per-partition, because one slow partition can look like a global gap, and check whether processing time changed. The count alone cannot distinguish the two cases; the rate difference and its persistence can.",
    followUps: [
      "What window would you use to separate a burst from a new baseline?",
      "How would a consumer deploy show up in these signals?",
      "What would you do if capacity is enough but one partition is not?",
    ],
    redFlags: [
      "Waits for the backlog to clear without checking rates.",
      "Adds capacity while production is already falling.",
      "Ignores per-partition lag.",
    ],
    rubric: [
      "Uses the sign of capacity minus production.",
      "Checks whether the rate change persists.",
      "Separates a partition bottleneck from a global gap.",
      "Ties the decision to time-to-catch-up.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show lag count, time-to-catch-up, and lag age together.",
      "Production rate and per-consumer processing rate are measured, not assumed.",
      "Alerts are tied to the freshness objective, with a sustained window.",
      "Partition count and per-partition lag are visible for every consumer group.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compute net drain before adding consumers.",
      "Check whether one partition or member is the bottleneck.",
      "Check downstream latency and poison records, not only consumer CPU.",
      "Watch time-to-catch-up and age during the drain; do not stop at the count.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that lag age returned inside the freshness objective.",
      "Review whether capacity headroom covers the next peak.",
      "Remove idle consumers beyond the partition count.",
      "Test the alert with a synthetic backlog and a real downstream rate.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: consumer group lag",
    url: "https://kafka.apache.org/documentation/#basic_ops_consumer_lag",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "How consumer group lag is described and inspected with Kafka tools.",
  },
  {
    title: "Apache Kafka documentation: monitoring",
    url: "https://kafka.apache.org/documentation/#monitoring",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Consumer, producer, and broker metrics used to interpret lag.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "consumer-lag": {
      model: consumerLagModel,
      presets,
      instructions:
        "Start Healthy, then apply Never catches up. Run the experiment, then compare Add one consumer with Ten consumers. Watch time-to-catch-up and lag age, not the count.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Catch-up time is capped at one day; the rates are teaching values, not benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-consumer-groups",
    "streaming-kafka-partitions",
    "streaming-partition-count",
    "streaming-backpressure",
    "streaming-hot-partition",
  ],
};
