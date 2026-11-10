import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "arrivalRate",
    label: "Arrival rate",
    min: 10,
    max: 1_000,
    step: 10,
    value: 200,
    unit: " msg/s",
    group: "Traffic",
    help: "Messages arriving at both queues. The two queues differ in how much service capacity they receive.",
    format: "rps" as const,
  },
  {
    id: "serviceRate",
    label: "Total service rate",
    min: 10,
    max: 1_000,
    step: 10,
    value: 400,
    unit: " msg/s",
    group: "Consumers",
    help: "Messages per second the consumer fleet can process across both queues.",
    format: "rps" as const,
  },
  {
    id: "fastBacklog",
    label: "Fast queue depth",
    min: 100,
    max: 20_000,
    step: 100,
    value: 10_000,
    unit: " msg",
    group: "Queues",
    help: "Messages already waiting in the fast queue at the start. A large backlog can still drain quickly.",
    format: "count" as const,
  },
  {
    id: "slowShare",
    label: "Slow queue service share",
    min: 10,
    max: 90,
    step: 1,
    value: 50,
    unit: "%",
    group: "Queues",
    help: "Share of service capacity assigned to the slow queue. The fast queue gets the remainder.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  arrival: number;
  service: number;
  slowShare: number;
  fastDepth: number;
  slowDepth: number;
  fastService: number;
  slowService: number;
  fastAge: number;
  slowAge: number;
  util: number;
}

function ageFor(depth: number, service: number, arrival: number): number {
  if (depth <= 0) return 0;
  const drain = service - arrival;
  if (drain > 0) return depth / drain;
  return depth / Math.max(1, service);
}

function compute(p: Params, fastDepth: number, slowDepth: number): Values {
  const arrival = Math.round(clamp(num(p, "arrivalRate", 200), 10, 1_000));
  const service = Math.round(clamp(num(p, "serviceRate", 400), 10, 1_000));
  const slowShare = Math.round(clamp(num(p, "slowShare", 50), 10, 90));
  const fastService = (service * (100 - slowShare)) / 100;
  const slowService = (service * slowShare) / 100;
  return {
    arrival,
    service,
    slowShare,
    fastDepth,
    slowDepth,
    fastService,
    slowService,
    fastAge: ageFor(fastDepth, fastService, arrival),
    slowAge: ageFor(slowDepth, slowService, arrival),
    util: (arrival / Math.max(1, service)) * 100,
  };
}

function buildFrame(p: Params, seed: number, fastDepth: number, slowDepth: number): SimFrame {
  const values = compute(p, fastDepth, slowDepth);
  const fastHealth = values.fastAge >= 300 ? "crit" : values.fastAge >= 90 ? "warn" : "ok";
  const slowHealth = values.slowAge >= 30 ? "crit" : values.slowAge >= 10 ? "warn" : "ok";
  const total = fastDepth + slowDepth;
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Order events",
        kind: "service",
        health: "ok",
        utilization: clamp(values.arrival / 1_000),
        throughput: values.arrival,
        sublabel: `${values.arrival} msg/s to each queue`,
        detail: "The producer sends to both queues. Depth is not comparable across them because their service rates differ.",
        meta: { view: "flow" },
      },
      {
        id: "fast-queue",
        label: "Fast queue",
        kind: "queue",
        health: fastHealth,
        utilization: clamp(values.arrival / Math.max(1, values.fastService)),
        throughput: values.arrival,
        capacity: values.fastService,
        sublabel: `${Math.round(values.fastDepth).toLocaleString("en-US")} waiting · ${values.fastAge.toFixed(0)}s age`,
        detail: `The fast queue receives ${values.fastService.toFixed(0)} messages/s of service against ${values.arrival}/s arriving. ${values.fastService > values.arrival ? `It drains at ${(values.fastService - values.arrival).toFixed(0)}/s, so the oldest wait is about ${values.fastAge.toFixed(0)}s.` : "It is not draining, so age grows despite the depth number."}`,
        meta: { view: "flow", depth: values.fastDepth },
      },
      {
        id: "slow-queue",
        label: "Slow queue",
        kind: "queue",
        health: slowHealth,
        utilization: clamp(values.arrival / Math.max(1, values.slowService)),
        throughput: values.arrival,
        capacity: values.slowService,
        sublabel: `${Math.round(values.slowDepth).toLocaleString("en-US")} waiting · ${values.slowAge.toFixed(0)}s age`,
        detail: `The slow queue receives ${values.slowService.toFixed(0)} messages/s of service against ${values.arrival}/s arriving. ${values.slowService > values.arrival ? "It drains, but the drain rate sets the wait." : "Service is below arrival, so the shallow queue still leaves messages waiting far beyond the latency budget."}`,
        meta: { view: "flow", depth: values.slowDepth },
      },
      {
        id: "consumers",
        label: "Consumer fleet",
        kind: "worker",
        health: slowHealth === "crit" ? "crit" : "ok",
        utilization: clamp(values.util / 100),
        throughput: Math.min(values.arrival, values.service),
        capacity: values.service,
        sublabel: `${values.service} msg/s capacity`,
        detail: `The fleet is split between the queues. ${values.slowShare}% goes to the slow queue, which is why its depth can be small while its age is large.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("producer-fast", "producer", "fast-queue", clamp(values.arrival / 1_000), fastHealth),
      edge("producer-slow", "producer", "slow-queue", clamp(values.arrival / 1_000), slowHealth),
      edge("fast-consumers", "fast-queue", "consumers", clamp(values.arrival / Math.max(1, values.fastService)), fastHealth),
      edge("slow-consumers", "slow-queue", "consumers", clamp(values.arrival / Math.max(1, values.slowService)), slowHealth),
    ],
    metrics: [
      metric("oldest-age-fast", "Fast queue oldest age", values.fastAge, " s", 90, 300, "ms"),
      metric("oldest-age-slow", "Slow queue oldest age", values.slowAge, " s", 10, 30, "ms"),
      metric("queueDepth", "Total messages waiting", total, " messages", undefined, undefined, "count"),
      metric("service-util", "Service utilization", values.util, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, fastJson: String(fastDepth), slowJson: String(slowDepth) },
    summary: `Fast queue ${Math.round(fastDepth).toLocaleString("en-US")} deep at ${values.fastAge.toFixed(0)}s; slow queue ${Math.round(slowDepth).toLocaleString("en-US")} deep at ${values.slowAge.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "oldest-age-fast", Math.max(0, values.fastAge * (0.97 + 0.03 * Math.sin(index / 2.4))));
    recordSeries(frame, "oldest-age-slow", Math.max(0, values.slowAge * (0.94 + 0.06 * Math.sin(index / 2))));
    recordSeries(frame, "queueDepth", Math.max(0, (values.fastDepth + values.slowDepth) * (0.98 + 0.02 * Math.sin(index / 2.6))));
    recordSeries(frame, "service-util", Math.max(0, values.util * (0.99 + 0.01 * Math.sin(index / 2.2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "slow-age",
    metricId: "oldest-age-slow",
    warn: 10,
    crit: 30,
    title: "The shallow queue is breaching its latency budget",
    cause:
      "The slow queue has few messages but a service rate below arrival. Its depth looks harmless, yet the oldest message waits longer than the budget because the queue drains too slowly or not at all.",
    fix:
      "Give the queue more service capacity, reduce arrival, or route work elsewhere. Alert on oldest message age and drain rate, not on depth alone.",
    checkFirst: [
      "Check ApproximateAgeOfOldestMessage for the queue.",
      "Compare arrival rate with the queue's actual service rate.",
      "Check whether consumers are shared with a busier queue.",
    ],
  },
  {
    id: "fast-age",
    metricId: "oldest-age-fast",
    warn: 90,
    crit: 300,
    title: "The deep queue is draining too slowly",
    cause:
      "A large depth can be acceptable when the queue drains quickly. If service falls toward arrival, the same depth turns into a long wait, and the age grows faster than the count suggests.",
    fix:
      "Increase drain capacity or reduce arrival. Use age to decide whether the depth is a problem, and forecast drain time as depth divided by net service rate.",
    checkFirst: [
      "Check net drain rate, not only consumer count.",
      "Check whether the backlog is growing or shrinking.",
      "Check the age of the oldest message.",
    ],
  },
  {
    id: "service-util",
    metricId: "service-util",
    warn: 80,
    crit: 95,
    title: "The consumer fleet has little service headroom",
    cause:
      "Total service capacity is close to arrival, so any burst increases both queues. When utilization reaches the arrival rate, depth alone stops telling you which queue is in trouble.",
    fix:
      "Add consumer capacity within downstream limits, or shed low-priority work. Keep the per-queue split visible so one queue is not starved.",
    checkFirst: [
      "Check total service rate against arrival rate.",
      "Check per-queue capacity allocation.",
      "Check downstream latency, which may be the real service limit.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const queueDepthModel: SimModel = {
  id: "streaming-queue-depth",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 10_000, 100);
    const frame = buildFrame(defaults(), seed, 10_000, 100);
    seedSeries(frame, values);
    return frame;
  },
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 || frame.flags.paramsKey !== key;
    const fast = fresh ? clamp(num(p, "fastBacklog", 10_000), 100, 20_000) : Number(frame.flags.fastJson ?? 10_000);
    const slow = fresh ? 100 : Number(frame.flags.slowJson ?? 100);
    const base = compute(p, fast, slow);
    const seconds = Math.min(1, Math.max(0.01, dt));
    const fastDepth = Math.max(0, fast + (base.arrival - base.fastService) * seconds);
    const slowDepth = Math.max(0, slow + (base.arrival - base.slowService) * seconds);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), fastDepth, slowDepth);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.paramsKey = key;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 10_000, 100);
    const items: string[] = [];
    items.push(`Depth is work in the queue; wait is depth divided by the rate the queue drains. The slow queue's ${values.slowDepth.toFixed(0)} messages can wait longer than the fast queue's ${values.fastDepth.toLocaleString("en-US")}.`);
    items.push(`The slow queue gets ${values.slowService.toFixed(0)} messages/s of service against ${values.arrival}/s arriving. ${values.slowService > values.arrival ? "It drains." : "It does not drain, so age grows without bound while depth stays modest at first."}`);
    items.push(`The fast queue drains at ${(values.fastService - values.arrival).toFixed(0)} messages/s net. Its deep backlog is a wait problem only if the drain rate falls.`);
    items.push("Little's Law relates queue length, arrival rate, and time in system. A depth number without a rate cannot tell you the wait.");
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
    description: "The deep fast queue drains; the shallow slow queue also drains inside its budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Arrival rises and the slow queue gets only 40% of service; its age starts to warn.",
    tone: "warn",
    params: defaults({ arrivalRate: 240, serviceRate: 500, fastBacklog: 8_000, slowShare: 30 }),
  },
  {
    id: "failure",
    label: "Shallow but stuck",
    description: "The slow queue holds only 100 messages but gets 10% of service against 200 arrivals/s.",
    tone: "crit",
    params: defaults({ arrivalRate: 200, serviceRate: 400, fastBacklog: 10_000, slowShare: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Arrival falls and both queues get service headroom; the slow queue drains in seconds.",
    tone: "ok",
    params: defaults({ arrivalRate: 100, serviceRate: 400, fastBacklog: 10_000, slowShare: 50 }),
  },
  {
    id: "balanced",
    label: "Balanced split",
    description: "Both queues receive enough service and the deep backlog drains steadily.",
    tone: "ok",
    params: defaults({ arrivalRate: 150, serviceRate: 600, fastBacklog: 10_000, slowShare: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-depth-latency",
  title: "Predict which queue times out",
  simId: "queue-depth",
  question:
    "Queue A has 10k messages and drains 300 messages/s net. Queue B has 100 messages and drains 5 messages/s net. Which has the older head-of-line message?",
  prediction: {
    options: [
      { id: "a", label: "Queue A, because its depth is 100 times larger" },
      { id: "b", label: "Queue B, because the wait is depth divided by the net drain rate" },
      { id: "same", label: "They are equal; depth and age always move together" },
      { id: "unknown", label: "Neither can be determined without the consumer count" },
    ],
    correctOptionId: "b",
    explanation:
      "Queue A's oldest message waits about 10,000 divided by 300, or 33 seconds. Queue B's waits about 100 divided by 5, or 20 seconds at first and longer as the backlog grows. Depth alone is ambiguous; the drain rate converts work into time. If Queue B's service is below arrival, its wait grows without bound even while depth stays small.",
  },
  setup: defaults({ arrivalRate: 200, serviceRate: 400, fastBacklog: 10_000, slowShare: 10 }),
  runFor: 30,
  observe: [
    "The slow queue's depth is small and its oldest age is large.",
    "The fast queue's depth is large and its age is moderate because it drains.",
    "Oldest age crosses the slow queue's budget before total depth looks alarming.",
    "Service utilization and per-queue allocation explain both.",
  ],
  explain:
    "Queue depth counts work. Wait is work divided by the rate at which that work drains. Two queues with the same arrival rate but different service allocations can have inverted depth and age. The operational signal is the age of the oldest message, because that is what the next consumer will experience. Depth is useful for capacity planning and drain forecasts, not as a standalone latency alarm.",
  fix: defaults({ arrivalRate: 200, serviceRate: 400, fastBacklog: 10_000, slowShare: 50 }),
  debrief:
    "The fix gives the slow queue half the service capacity, so it drains and its oldest age falls below the budget. The fast queue still has a deep backlog, but it drains fast enough to meet its own budget. The trade is that service is now split evenly; a queue with a tighter SLA needs a larger share or its own consumers.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Queue depth is the number of messages waiting. It is a count of work, not a measure of delay. The same depth can mean seconds or hours depending on how fast the queue drains. Age of the oldest message is the user-facing signal: it is how long the next message has already waited, and it maps directly to the latency a consumer or user experiences.",
  },
  {
    type: "p",
    text: "Little's Law relates the three quantities: average number in the system equals arrival rate times average time in the system. Rearranged, wait is depth divided by throughput or net drain rate. A queue with 10k messages and 300 messages/s of net drain has about 33 seconds of head-of-line wait. A queue with 100 messages and 5 messages/s of net drain has 20 seconds, and if service is below arrival, that wait keeps growing.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, queue, consumer. Depth rises when arrival exceeds service and falls when service exceeds arrival. The net rate, not the consumer count, determines the wait. A queue can be shallow and stuck if almost all of its service goes elsewhere, and deep and healthy if it drains quickly.",
  },
  {
    type: "compare",
    leftTitle: "Depth",
    rightTitle: "Oldest age",
    rows: [
      { label: "What it measures", left: "Messages waiting", right: "Time the oldest message has waited" },
      { label: "User impact", left: "Indirect", right: "Direct latency for the next consumer" },
      { label: "Good for", left: "Capacity and drain forecasts", right: "SLO alerts and triage" },
      { label: "Blind spot", left: "Slow drain makes a small depth dangerous", right: "Needs a clock and per-queue visibility" },
    ],
  },
  {
    type: "p",
    text: "This module uses two queues with 10 to 1,000 messages/s and a service split. Those are illustrative teaching values. The shape of the failure is the lesson: the shallow queue has the older message because its drain rate is lower.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Oldest age for the fast and slow queues, each with its own budget. Slow queue warning at 10 seconds, critical at 30; fast queue warning at 90, critical at 300.",
      "Total messages waiting, which is useful for drain planning but not for latency alone.",
      "Service utilization and the per-queue service split.",
      "A flow view with two queues of different depths and drain rates.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Shallow but stuck. Run the experiment before changing the service split. Compare the two queues by age, not by bar length, and finish with Recovery.",
  },
  { type: "sim", simId: "queue-depth" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fast queue held 10k messages but drained at 200 messages/s net, so its oldest wait was about 50 seconds. The slow queue held 100 messages and received only 40 messages/s of service against 200 arrivals, so it did not drain at all. Its oldest wait passed the 30-second budget while its depth was still tiny.",
  },
  {
    type: "p",
    text: "Rebalancing service to the slow queue let it drain and brought its age below the budget. The fast queue kept a deep but bounded backlog. Total depth barely moved, which is why a single queue-depth alarm would have missed the failing queue and flagged the healthy one.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "SQS or broker metrics: ApproximateNumberOfMessagesVisible and ApproximateAgeOfOldestMessage per queue.",
      "Consumer service rate per queue, including time spent on downstream calls.",
      "Queue-level capacity allocation when consumers are shared.",
      "Producer arrival rate and burst patterns.",
      "User-facing latency for the work the queue feeds.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check oldest message age and net drain rate for each queue before comparing depths. Check whether the slow queue is starved of consumers by a busier queue. Then check arrival and service separately, because the ratio is what turns depth into wait.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Alert on oldest message age against the queue's latency budget.",
      "Compute net drain as service rate minus arrival rate for each queue.",
      "Give a slow queue its own consumers or a larger service share.",
      "Reduce arrival or shed low-priority work if total service is the limit.",
      "Use depth for drain forecasts and capacity, not as the only latency signal.",
      "Check downstream latency, because it can lower the real service rate.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Oldest age catches user impact but needs per-queue instrumentation and a clock.",
      "Depth is cheap and useful for capacity, but ambiguous for latency.",
      "Splitting consumers per queue improves isolation but reduces pooling flexibility.",
      "A larger service share for one queue starves another unless total capacity rises.",
      "Adding consumers helps only if the downstream service can absorb them.",
      "A short latency budget catches problems early but creates more noise during bursts.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "depth-not-latency",
    question:
      "Queue A has 10k messages and is healthy; Queue B has 100 and is timing out. How is that possible?",
    difficulty: 2,
    hints: [
      "Wait is depth divided by drain rate.",
      "A queue can have low depth and near-zero service.",
    ],
    answer:
      "Queue A drains quickly, so 10k messages might be a minute of work. Queue B has few messages but little or no service capacity relative to arrival, so its oldest message waits far longer. I would compare oldest message age, arrival rate, and service rate for each queue. Depth alone cannot distinguish a large fast-draining backlog from a small stuck one.",
    followUps: [
      "Which metric would you alert on?",
      "How do you compute drain time?",
      "What if both queues share consumers?",
    ],
    redFlags: [
      "Assumes depth is proportional to wait.",
      "Compares queues without their rates.",
      "Adds consumers without checking the split.",
    ],
    rubric: [
      "Uses depth divided by drain rate.",
      "Names oldest age as the signal.",
      "Checks per-queue service.",
    ],
  },
  {
    id: "age-alert",
    question:
      "How would you set an alert for a queue that feeds a checkout flow with a 30-second latency budget?",
    difficulty: 3,
    hints: [
      "Age maps directly to the user wait.",
      "Depth needs a rate to become time.",
    ],
    answer:
      "I would alert on ApproximateAgeOfOldestMessage against the 30-second budget, with a warning below it and a page when it stays above it. I would also track net drain and arrival rate to predict when age will cross. Depth can support capacity planning, but it is not the page. I would set the threshold from the end-to-end budget minus downstream processing time, not from a round number.",
    followUps: [
      "How do you avoid flapping on bursts?",
      "What is the leading indicator?",
      "How does a DLQ change the picture?",
    ],
    redFlags: [
      "Alerts only on depth.",
      "Uses a threshold unrelated to the user budget.",
      "Ignores downstream time.",
    ],
    rubric: [
      "Alerts on oldest age.",
      "Ties the threshold to the budget.",
      "Adds a leading drain signal.",
    ],
  },
  {
    id: "little-law",
    question:
      "Use Little's Law to estimate the wait for a queue with 2,000 messages, 50 messages/s arriving, and 60 messages/s being served.",
    difficulty: 3,
    hints: [
      "Net drain is service minus arrival.",
      "Depth divided by net drain gives the time to clear.",
    ],
    answer:
      "The queue drains at 10 messages/s net. Two thousand messages divided by 10 is 200 seconds to clear, so the oldest message waits about 200 seconds if the rate holds. The average wait for a newly arrived message is smaller, but the head-of-line wait is the number that matters for the oldest work. If arrival rises to 60, the queue stops draining and the estimate no longer applies.",
    followUps: [
      "What if arrival equals service?",
      "Why is the head-of-line wait not the average?",
      "How would batching change the estimate?",
    ],
    redFlags: [
      "Divides by service only and ignores arrival.",
      "Confuses average wait with oldest wait.",
      "Assumes the rate holds during a burst.",
    ],
    rubric: [
      "Computes net drain.",
      "Divides depth by net drain.",
      "Notes the steady-state assumption.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every queue has an oldest-message-age metric and a latency budget.",
      "Per-queue arrival and service rates are visible, including shared consumers.",
      "Dashboards do not treat depth as a latency proxy.",
      "Drain forecasts use net service rate, not consumer count.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check oldest age before comparing queue depths.",
      "Check whether a slow queue is starved by a busier one.",
      "Check whether service is below arrival, which makes wait unbounded.",
      "Protect downstream services while the backlog drains.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify age and net drain at peak.",
      "Rebalance consumers or service shares by queue budget.",
      "Add a synthetic message age check to catch clock and metric gaps.",
    ],
  },
];

const references = [
  {
    title: "Amazon SQS CloudWatch metrics",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "ApproximateNumberOfMessagesVisible and ApproximateAgeOfOldestMessage.",
  },
  {
    title: "Google SRE Book: handling overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google",
    kind: "book" as const,
    note: "Queueing, load shedding, and why backlog needs a rate to be meaningful.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "queue-depth": {
      model: queueDepthModel,
      presets,
      instructions:
        "Start healthy, apply Shallow but stuck, then run the experiment. Compare the two queues by oldest age and net drain, not depth. Finish with Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Queue depths, rates, and service splits are teaching values, not queue limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-littles-law", "streaming-consumer-lag", "streaming-sqs-visibility"],
};
