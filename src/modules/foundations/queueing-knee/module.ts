import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "arrivalRate",
    label: "Arrival rate",
    min: 200,
    max: 3_000,
    step: 50,
    value: 800,
    unit: " rps",
    group: "Demand",
    help: "Requests offered per second. This is the load that consumes server capacity.",
    format: "rps" as const,
  },
  {
    id: "serviceTimeMs",
    label: "Service time",
    min: 5,
    max: 100,
    step: 1,
    value: 20,
    unit: "ms",
    group: "Capacity",
    help: "Mean time one request occupies a server, excluding queue wait.",
    format: "ms" as const,
  },
  {
    id: "servers",
    label: "Servers",
    min: 2,
    max: 80,
    step: 1,
    value: 30,
    unit: "",
    group: "Capacity",
    help: "Parallel servers. Capacity is servers divided by service time.",
    format: "count" as const,
  },
  {
    id: "variabilityCv",
    label: "Arrival variability",
    min: 0.2,
    max: 2.5,
    step: 0.1,
    value: 0.8,
    unit: " CV",
    group: "Demand",
    help: "Coefficient of variation for inter-arrival time. Higher values mean burstier arrivals and a sharper knee.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  arrival: number;
  serviceMs: number;
  servers: number;
  cv: number;
  capacity: number;
  utilization: number;
  waitMs: number;
  queueDepth: number;
  p99: number;
  concurrency: number;
  throughput: number;
}

function compute(p: Params, t: number): Computed {
  const arrival = Math.max(1, num(p, "arrivalRate", 800));
  const serviceMs = Math.max(1, num(p, "serviceTimeMs", 20));
  const servers = Math.max(1, Math.round(num(p, "servers", 30)));
  const cv = Math.max(0.05, num(p, "variabilityCv", 0.8));
  const capacity = (servers * 1_000) / serviceMs;
  const utilization = arrival / capacity;
  const bounded = Math.min(utilization, 0.9999);
  const queueFactor = bounded / Math.max(0.0001, 1 - bounded);
  const waitMs = queueFactor * ((cv ** 2 + 1) / 2) * serviceMs;
  const baseQueueDepth = (arrival * waitMs) / 1_000;
  const queueDepth =
    utilization <= 1 ? baseQueueDepth : baseQueueDepth + (arrival - capacity) * Math.max(0, t);
  const p99 = Math.min(60_000, serviceMs + waitMs * Math.log(100));
  return {
    arrival,
    serviceMs,
    servers,
    cv,
    capacity,
    utilization,
    waitMs,
    queueDepth,
    p99,
    concurrency: (arrival * (serviceMs + waitMs)) / 1_000,
    throughput: Math.min(arrival, capacity),
  };
}

function healthFor(utilization: number, p99: number): "ok" | "warn" | "crit" {
  if (p99 >= 1_000 || utilization >= 0.98) return "crit";
  if (p99 >= 250 || utilization >= 0.8) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.5);
  const entries: [string, number, number][] = [
    ["p99", values.p99, 6],
    ["utilization", values.utilization * 100, 0.8],
    ["queueDepth", values.queueDepth, 2],
    ["wait", values.waitMs, 1.5],
    ["throughput", values.throughput, 15],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2 + value) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number, t = 0): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v.utilization, v.p99);
  const groupCount = Math.min(3, v.servers);
  const basePool = Math.floor(v.servers / groupCount);
  const remainder = v.servers % groupCount;
  const pools = Array.from({ length: groupCount }, (_, index) => basePool + (index < remainder ? 1 : 0));
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Request producer",
        kind: "service",
        health: "ok",
        utilization: clamp(v.arrival / 3_000),
        throughput: v.arrival,
        sublabel: `${Math.round(v.arrival)} rps offered`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "Wait queue",
        kind: "queue",
        health,
        utilization: clamp(v.utilization),
        throughput: v.arrival,
        sublabel: `${Math.round(v.queueDepth).toLocaleString()} waiting`,
        detail: `Utilization is ${Math.round(v.utilization * 100)}%. Mean wait is ${v.waitMs.toFixed(0)}ms; p99 is ${v.p99.toFixed(0)}ms. The knee is a curve, not a line.`,
        meta: { view: "queue", depth: v.queueDepth },
      },
      ...pools.map((poolSize, index) => ({
        id: `server-${index + 1}`,
        label: `Server group ${String.fromCharCode(65 + index)}`,
        kind: "worker" as const,
        role: "instance" as const,
        health,
        utilization: clamp(v.utilization),
        throughput: (v.capacity * poolSize) / v.servers,
        sublabel: `${poolSize} server${poolSize === 1 ? "" : "s"}`,
        detail: `${poolSize} of ${v.servers} servers. They are busy ${Math.round(clamp(v.utilization) * 100)}% of the time; arrival variability determines how long requests wait.`,
        meta: { view: "queue" },
      })),
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(v.utilization), health),
      ...pools.map((poolSize, index) =>
        edge(
          `queue-server-${index + 1}`,
          "queue",
          `server-${index + 1}`,
          clamp(v.utilization * (poolSize / v.servers) + 0.1),
          health,
        ),
      ),
    ],
    metrics: [
      metric("p99", "p99 latency", v.p99, "ms", 250, 1_000, "ms"),
      metric("utilization", "Utilization", v.utilization * 100, "%", 70, 95, "percent"),
      metric("queueDepth", "Queue depth", v.queueDepth, " req", 100, 1_000, "count"),
      metric("wait", "Mean queue wait", v.waitMs, "ms", 80, 400, "ms"),
      metric("concurrency", "In-flight requests", v.concurrency, " req", 100, 500, "count"),
      metric("throughput", "Throughput", v.throughput, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), kneeCrossed: 0 },
    summary: `${Math.round(v.utilization * 100)}% utilization, ${v.p99.toFixed(0)}ms p99, ${Math.round(v.queueDepth)} queued. At ${v.cv.toFixed(1)} CV the knee is steep.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 250,
    crit: 1_000,
    title: "p99 latency crossed the SLO at moderate utilization",
    cause:
      "Queueing delay grows nonlinearly as utilization approaches capacity. At 80% utilization with bursty arrivals, the queue is already deep even though the server has nominal headroom.",
    fix:
      "Reduce arrival variability, reduce service time, or add enough capacity to move utilization away from the knee. Do not wait for utilization to reach 100% before acting.",
    checkFirst: [
      "Plot utilization and p99 on the same time axis.",
      "Check the coefficient of variation or burst size of arrivals.",
      "Check whether service time changed at the same time as load.",
    ],
  },
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 100,
    crit: 1_000,
    title: "The wait queue is deep enough to dominate latency",
    cause:
      "Requests are arriving faster than servers become free, or arrivals are bursty enough that the queue does not drain between bursts.",
    fix:
      "Smooth the arrival rate, add capacity, or apply admission control. A deeper queue does not add throughput; it adds waiting.",
    checkFirst: [
      "Check queue depth against arrival rate and service time.",
      "Check whether the queue drains between bursts.",
      "Check for retries that add duplicate arrivals.",
    ],
  },
  {
    id: "utilization",
    metricId: "utilization",
    warn: 70,
    crit: 95,
    title: "Utilization is in the region where latency is unstable",
    cause:
      "At high utilization, the same load produces a wide range of latency because idle capacity is the buffer that absorbs bursts. The average utilization hides how little slack remains.",
    fix:
      "Set a utilization target that leaves room for the observed variability and for one failure domain. Add capacity or reduce service time before the next peak.",
    checkFirst: [
      "Check utilization per instance, not only the fleet average.",
      "Check the peak-to-average ratio for the traffic.",
      "Check whether the service time is stable or has a long tail.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const queueingKneeModel: SimModel = {
  id: "foundations-queueing-knee",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t);
    next.t = frame.t;
    const key = JSON.stringify(p);
    const changed = frame.flags.paramsKey !== key;
    next.flags = { ...frame.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (changed && frame.t <= 0.11) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = frame.series;
    }
    const jitter = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "concurrency" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.p99 >= 1_000 && values.utilization < 0.85 && frame.flags.kneeCrossed !== 1) {
      pushEvent(next, {
        id: "knee-crossed",
        at: frame.t,
        severity: "crit",
        title: "The knee arrived before 100% utilization",
        detail: `p99 is ${values.p99.toFixed(0)}ms at ${Math.round(values.utilization * 100)}% utilization. Bursty arrivals turn the remaining headroom into queue wait.`,
        nodeId: "queue",
        metricId: "p99",
      });
      next.flags.kneeCrossed = 1;
    }
    if (values.p99 < 500) next.flags.kneeCrossed = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${Math.round(values.utilization * 100)}% utilization, ${values.p99.toFixed(0)}ms p99, ${Math.round(values.queueDepth)} queued. At ${values.cv.toFixed(1)} CV the knee is steep.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    const items = [
      `Utilization is ${Math.round(v.utilization * 100)}%: ${Math.round(v.arrival)} rps offered against ${Math.round(v.capacity)} rps of capacity.`,
      `Mean queue wait is ${v.waitMs.toFixed(0)}ms and p99 is ${v.p99.toFixed(0)}ms; the gap is the queue, not the service time.`,
      `Arrival variability is ${v.cv.toFixed(1)} CV. Higher variability multiplies the wait at the same utilization.`,
    ];
    if (v.utilization < 0.85 && v.p99 >= 1_000) {
      items.push("A utilization target alone would have called this healthy. The latency curve is the better warning.");
    }
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
    description: "53% utilization with calm arrivals. The queue is shallow and p99 is stable.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "80% utilization with moderate bursts. p99 is above its warning line but below the SLO.",
    tone: "warn",
    params: defaults({ arrivalRate: 1_200, variabilityCv: 1.2 }),
  },
  {
    id: "failure",
    label: "Bursty at 80%",
    description: "Same 80% utilization, but arrival variability is 2.5 CV. p99 crosses the SLO.",
    tone: "crit",
    params: defaults({ arrivalRate: 1_200, variabilityCv: 2.5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Add servers to move utilization away from the knee while keeping the same traffic.",
    tone: "ok",
    params: defaults({ arrivalRate: 1_200, servers: 45, variabilityCv: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-knee",
  title: "Predict which change breaks the latency SLO",
  simId: "queueing-knee",
  question:
    "At 80% utilization, which change pushes p99 from 469ms to over one second without changing the average load?",
  prediction: {
    options: [
      { id: "variability", label: "Arrival variability rises from 1.2 to 2.5 CV" },
      { id: "servers", label: "A server group is added" },
      { id: "service", label: "Service time falls" },
      { id: "cache", label: "The cache hit rate rises" },
    ],
    correctOptionId: "variability",
    explanation:
      "Queue wait depends on utilization and variability. At 80% utilization, more bursty arrivals create longer runs of back-to-back work and longer idle gaps. The average load is unchanged, but the queue has less slack to absorb the bursts.",
  },
  setup: defaults({ arrivalRate: 1_200, variabilityCv: 2.5 }),
  runFor: 20,
  observe: [
    "Utilization stays at 80% in both presets.",
    "Mean queue wait rises from about 98ms to about 290ms.",
    "p99 rises from about 469ms to about 1,355ms and crosses the 1,000ms SLO.",
    "Queue depth grows from about 117 to about 348 requests.",
  ],
  explain:
    "The knee is not a fixed percentage. It is the region where the remaining idle capacity is too small to absorb the arrival pattern. With low variability, 80% utilization can be safe. With high variability, the same 80% is already past the knee. Capacity planning has to account for the shape of arrivals, not just their mean.",
  fix: defaults({ arrivalRate: 1_200, servers: 45, variabilityCv: 1 }),
  debrief:
    "Adding servers moves utilization to 53% and restores a stable queue at the same arrival rate. Smoothing arrivals would also work, but it changes the traffic shape rather than the capacity. The tradeoff is real: extra servers cost money every hour, while smoothing may delay work or require a queue in front of the service.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "Utilization is the share of server capacity in use. Queueing delay is the time a request waits before a server becomes free. They are not linearly related. As utilization approaches 100%, the idle capacity that absorbs bursts disappears, and the same small load increase produces a much larger wait. The region where the curve bends upward is the queueing knee.",
  },
  {
    type: "p",
    text: "A simple model makes the shape visible. For a single server with random arrivals and random service, mean wait is proportional to ρ / (1 − ρ), where ρ is utilization. At 50% utilization the factor is 1; at 80% it is 4; at 90% it is 9; at 95% it is 19. Those are model values for that queue, not universal constants. The point is the direction: each step closer to saturation costs more than the last.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "p",
    text: "The knee sits between capacity and latency. Capacity is servers divided by service time. Latency is service time plus queue wait. Variability enters through the arrival process and the service-time distribution: bursty arrivals and long service tails both make the queue less able to drain between bursts. A service can be at 75% average utilization and still cross its latency SLO if the arrivals are bursty enough.",
  },
  {
    type: "table",
    headers: ["Utilization", "Mean wait factor", "What it means"],
    rows: [
      ["50%", "1× service time", "Plenty of slack for bursts"],
      ["80%", "4× service time", "The knee is close; variability matters"],
      ["90%", "9× service time", "Small load changes produce large waits"],
      ["95%", "19× service time", "Almost no slack; latency is unstable"],
    ],
  },
  {
    type: "p",
    text: "The table uses the single-server random-arrival model as an illustration. Real systems have multiple servers, different service distributions, and admission control, so the numbers differ. The shape does not: queueing delay is convex near saturation. That is why a utilization target copied from a calm batch system can fail on a bursty API.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "Utilization, which stays at 80% in both the peak and failure presets.",
      "p99 latency, which separates the two presets even though the average load is identical.",
      "Queue depth and mean wait, which show where the latency is coming from.",
      "Arrival variability, the control that changes the shape of the knee.",
      "Throughput, which stops rising once the servers are saturated.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Peak and note that 80% utilization already produces a p99 warning. Then apply Bursty at 80%: utilization does not change, but p99 crosses the SLO. Move the variability slider yourself before you apply Recovery.",
  },
  { type: "sim", simId: "queueing-knee" },
  {
    type: "p",
    text: "The operational question is not whether 70% is a magic number. It is how much idle capacity you need to absorb the arrivals you actually receive. A service with steady traffic can run hotter than a service with spikes, retries, and long-tail dependencies. The target belongs to the workload, not to the dashboard.",
  },
  { type: "experiment", experimentId: "predict-knee" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Both the peak and failure presets offered 1,200 rps to thirty servers with a 20ms service time, so utilization was 80% in both. The peak preset had moderate arrivals and a p99 near 469ms. The failure preset had bursty arrivals, a mean wait near 290ms, and a p99 near 1,355ms. The only difference was the shape of the arrivals.",
  },
  {
    type: "p",
    text: "The queue depth rose from about 117 to about 348 requests. Throughput did not improve; the servers were already completing work at capacity. The extra latency was work waiting for the same servers. Adding servers moved utilization to 53% and restored headroom. Smoothing arrivals would have addressed the same curve from the other side.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CPU utilization per instance, plus run-queue length or load average, which show saturation rather than just busy time.",
      "Latency percentiles split by endpoint and instance; the average hides the tail that users feel.",
      "Request rate and concurrency, which distinguish a traffic increase from a service-time regression.",
      "Queue depth and age where a queue exists in front of the service.",
      "Burst size or peak-to-average ratio from the load balancer, which explains why the same utilization behaves differently.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare p99 with utilization over the same window. If p99 rises while utilization is flat, look at variability, service time, or a dependency. If both rise, decide whether the next step is capacity, load shaping, or admission control. Do not use a single utilization target as proof of health.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Plot the latency curve against utilization for the real traffic pattern, not a single average.",
      "Check whether the service-time distribution changed; a long tail moves the knee left.",
      "Measure arrival burstiness and peak-to-average ratio before choosing a headroom target.",
      "Add capacity to move utilization away from the knee, or smooth arrivals with a queue or rate limit.",
      "Bound the queue so excess work fails fast instead of waiting through the knee.",
      "Verify recovery at peak with the same bursty arrival pattern that caused the incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Headroom costs money at all times; the right amount depends on variability and the cost of missing the SLO.",
      "Smoothing arrivals can protect latency but adds a queue and delays low-priority work.",
      "A larger queue absorbs bursts but adds wait and memory; it does not add service capacity.",
      "Faster service time moves the knee, but optimizing the mean can leave the tail unchanged.",
      "Autoscaling adds capacity after the signal, which is often after the queue has already formed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-70",
    question:
      "Why can a service at 75% CPU be less healthy than a service at 95% CPU?",
    difficulty: 1,
    hints: [
      "Utilization is an average over a window.",
      "Queueing depends on variability and the remaining slack.",
    ],
    answer:
      "The percentage alone does not describe the queue. The 75% service may have bursty arrivals, long service times, or a dependency that stalls, so its remaining slack is consumed by bursts and its p99 is already high. The 95% service may have smooth, predictable work and still meet its latency target. I would compare p99, queue depth, and saturation alongside utilization, and I would look at the peak-to-average ratio. The target should come from the workload's variability and SLO, not from a universal threshold.",
    followUps: [
      "What would you graph to make the difference visible?",
      "How does service-time variability change the answer?",
      "When would 95% be a reasonable target?",
    ],
    redFlags: [
      "Treats 70% as a universal law.",
      "Ignores latency and queue depth.",
      "Assumes average utilization describes peak behavior.",
    ],
    rubric: [
      "Explains the average-versus-burst gap.",
      "Names p99 and saturation.",
      "Ties the target to variability and SLO.",
      "Avoids a universal percentage.",
    ],
  },
  {
    id: "p99-doubled",
    question:
      "CPU is at 75% and p99 doubled overnight. What are the possible causes, and how do you separate them?",
    difficulty: 2,
    hints: [
      "Utilization stayed the same, so load or service time changed shape.",
      "Look at arrivals, service time, and dependency latency separately.",
    ],
    answer:
      "If utilization is unchanged, the likely causes are a change in arrival variability, a change in the service-time distribution, or a dependency that adds wait without consuming CPU. I would split p99 by endpoint and instance, compare the arrival burst size, and check the service-time histogram. If p99 rose only on one dependency's calls, the cause is downstream. If p99 rose with queue depth on the same service, the arrival pattern or service time changed. I would also check retries, which add arrivals and can make the queue look busier without a traffic increase.",
    followUps: [
      "How would a long-tail service time move the knee?",
      "What if p50 is unchanged but p99 doubled?",
      "Which change would you roll back first?",
    ],
    redFlags: [
      "Assumes CPU is the only capacity signal.",
      "Looks only at the average.",
      "Adds servers without finding the shape change.",
    ],
    rubric: [
      "Separates variability, service time, and dependency.",
      "Uses percentile and queue evidence.",
      "Considers retries.",
      "Proposes a discriminating check.",
    ],
  },
  {
    id: "capacity-headroom",
    question:
      "How do you choose a utilization target for a new service with a 200ms p99 SLO?",
    difficulty: 3,
    hints: [
      "Start from the service-time budget and the arrival variability.",
      "Leave room for one failure domain and for bursts.",
    ],
    answer:
      "I would model the queue with the expected service time and arrival variability, then find the utilization where the modeled p99 fits inside 200ms with margin. I would validate the model with a load test that uses open-loop arrivals and the production traffic mix. Then I would subtract capacity for one failure domain, so the remaining instances can carry peak load. The target is a range, not a point: it should be revisited when service time, traffic shape, or the dependency tail changes. If the workload is bursty or the cost of missing the SLO is high, I would choose more headroom even if the average utilization looks wasteful.",
    followUps: [
      "What if the load test is closed-loop?",
      "How does a multi-tenant traffic mix change the target?",
      "When would you use admission control instead of more capacity?",
    ],
    redFlags: [
      "Picks a percentage without a latency model.",
      "Ignores failure domains.",
      "Trusts a closed-loop load test.",
    ],
    rubric: [
      "Starts from the SLO and service time.",
      "Accounts for variability and failure headroom.",
      "Validates with an open-loop test.",
      "Treats the target as workload-specific.",
    ],
  },
  {
    id: "smooth-or-add",
    question:
      "The queue is past the knee at peak. Do you smooth arrivals or add capacity?",
    difficulty: 3,
    hints: [
      "One changes the demand shape; the other changes the supply.",
      "Consider time-to-mitigate and the cost that remains after the peak.",
    ],
    answer:
      "I would choose based on the cause and the time horizon. If the bursts are caused by retries, a batch job, or a client that can be rate-limited, smoothing arrivals is the smaller and more durable fix because it removes work that does not need to be there. If the traffic is genuinely bursty and the product requires it, adding capacity is the direct fix, but it costs money outside the peak. In an incident I would protect the SLO first with admission control or load shedding, then decide between smoothing and capacity using the measured burst pattern. The wrong answer is to enlarge the queue and call it capacity.",
    followUps: [
      "How would you measure whether smoothing worked?",
      "What is the risk of rate-limiting a paying tenant?",
      "When would you combine both?",
    ],
    redFlags: [
      "Always adds capacity.",
      "Always blames the client.",
      "Enlarges the queue without bounding it.",
    ],
    rubric: [
      "Connects the fix to the cause.",
      "Names time-to-mitigate and cost.",
      "Protects the SLO during the incident.",
      "Rejects an unbounded queue as capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Latency is graphed against utilization for the real traffic shape.",
      "Dashboards show p99 and queue depth, not only average CPU.",
      "The utilization target accounts for arrival variability and one failure domain.",
      "Load tests use open-loop arrivals and the production traffic mix.",
      "Queues are bounded and their rejection behavior is tested.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether p99 rose with utilization or independently of it.",
      "Look for a change in arrival burstiness, service time, or a dependency tail.",
      "Decide whether to add capacity, smooth arrivals, or shed work.",
      "Do not use average utilization as proof that the service is healthy.",
      "Watch the queue depth after each change to confirm the knee moved.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify p99 and utilization at peak with the bursty pattern.",
      "Keep enough headroom for the next peak and one failure domain.",
      "Document the assumption behind the utilization target.",
      "Re-run the bursty experiment when traffic shape changes.",
    ],
  },
];

const references = [
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Queueing, overload, and the nonlinear path from utilization to latency.",
  },
  {
    title: "Performance Modeling and Design of Computer Systems",
    url: "https://www.cs.cmu.edu/~harchol/PerformanceModeling/book.html",
    publisher: "Mor Harchol-Balter",
    kind: "book" as const,
    note: "Queueing theory, utilization, and variability.",
  },
  {
    title: "The Tail at Scale",
    url: "https://research.google/pubs/the-tail-at-scale/",
    publisher: "Google Research",
    kind: "docs" as const,
    note: "Why tail latency and variability dominate large services.",
  },
  {
    title: "Queueing Systems, Volume I: Theory",
    url: "https://www.wiley.com/en-us/Queueing+Systems%2C+Volume+1%3A+Theory-p-9780471491101",
    publisher: "Leonard Kleinrock",
    kind: "book" as const,
    note: "The queueing foundations behind utilization, delay, and the knee.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "queueing-knee": {
      model: queueingKneeModel,
      presets,
      instructions:
        "Compare Peak and Bursty at 80%: utilization is identical, but p99 is not. Move the variability slider, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Queue wait uses a Kingman-style approximation and a simple overload branch; the shape of the knee is the lesson, not the exact milliseconds.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-littles-law",
    "foundations-use-red",
    "foundations-capacity-headroom",
    "capacity-queueing-headroom",
  ],
};
