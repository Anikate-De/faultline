import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RPS_PER_VCPU = 400;
const MEMORY_GB_PER_VCPU = 2;
const BASE_MEMORY_GB = 0.6;
const MEMORY_MB_PER_CONCURRENT = 26;
const SERVICE_TIME_SEC = 0.1;
const HOURS_PER_MONTH = 730;
const COST_PER_VCPU_HOUR = 0.042;

const params = [
  {
    id: "averageRps",
    label: "Average demand",
    min: 2_000,
    max: 40_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Demand",
    help: "Average request rate. The model ramps to the daily peak over eight simulated seconds.",
    format: "rps" as const,
  },
  {
    id: "fleetCount",
    label: "Fleet size",
    min: 10,
    max: 120,
    step: 1,
    value: 32,
    unit: " instances",
    group: "Fleet",
    help: "Number of identical instances in the fleet.",
    format: "count" as const,
  },
  {
    id: "instanceVcpu",
    label: "Instance size",
    min: 2,
    max: 16,
    step: 2,
    value: 4,
    unit: " vCPU",
    group: "Fleet",
    help: "vCPUs per instance. The model assumes 400 rps per vCPU at 100% and 2 GB of memory per vCPU.",
    format: "count" as const,
  },
  {
    id: "peakToAverage",
    label: "Peak-to-average ratio",
    min: 1.2,
    max: 5,
    step: 0.1,
    value: 2.4,
    unit: "×",
    group: "Demand",
    help: "Daily peak divided by average demand. A higher ratio means the average hides a larger burst.",
    format: "number" as const,
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

interface Computed {
  averageRps: number;
  peakRps: number;
  fleetCount: number;
  vcpu: number;
  capacity: number;
  averageUtil: number;
  peakUtil: number;
  p99: number;
  memoryUtil: number;
  monthlyCost: number;
  costPerM: number;
}

function compute(p: Params, t: number): Computed {
  const averageRps = Math.max(1, num(p, "averageRps", 8_000));
  const ratio = Math.max(1, num(p, "peakToAverage", 2.4));
  const peakFactor = 1 + (ratio - 1) * smoothstep(t / 8);
  const peakRps = averageRps * peakFactor;
  const fleetCount = Math.max(1, num(p, "fleetCount", 32));
  const vcpu = Math.max(1, num(p, "instanceVcpu", 4));
  const capacity = fleetCount * vcpu * RPS_PER_VCPU;
  const averageUtil = averageRps / Math.max(1, capacity);
  const peakUtil = peakRps / Math.max(1, capacity);
  const p99 =
    peakUtil <= 1
      ? 70 * (1 + (3 * Math.pow(peakUtil, 10)) / Math.max(0.15, 1.05 - peakUtil))
      : Math.min(15_000, 70 * 21 + (peakUtil - 1) * 4_000);
  const concurrency = peakRps * SERVICE_TIME_SEC;
  const memoryPerInstance = BASE_MEMORY_GB + (concurrency / fleetCount) * (MEMORY_MB_PER_CONCURRENT / 1024);
  const memoryCapacity = vcpu * MEMORY_GB_PER_VCPU;
  const monthlyCost = fleetCount * vcpu * HOURS_PER_MONTH * COST_PER_VCPU_HOUR;
  const monthlyRequestsM = (averageRps * 86_400 * 30) / 1_000_000;
  return {
    averageRps,
    peakRps,
    fleetCount,
    vcpu,
    capacity,
    averageUtil,
    peakUtil,
    p99,
    memoryUtil: (memoryPerInstance / Math.max(0.1, memoryCapacity)) * 100,
    monthlyCost,
    costPerM: monthlyCost / Math.max(1, monthlyRequestsM),
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.peakUtil >= 0.85 || values.p99 >= 800 || values.memoryUtil >= 95 || values.costPerM >= 0.35) {
    return "crit";
  }
  if (values.peakUtil >= 0.7 || values.p99 >= 300 || values.memoryUtil >= 80 || values.costPerM >= 0.2) {
    return "warn";
  }
  return "ok";
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const health = healthFor(values);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "requests",
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: health === "crit" ? "warn" : "ok",
        utilization: clamp(values.peakUtil),
        sublabel: `${Math.round(values.peakRps).toLocaleString("en-US")} rps peak`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Instance fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(values.peakUtil),
        throughput: Math.min(values.peakRps, values.capacity),
        capacity: values.capacity,
        sublabel: `${values.fleetCount} × ${values.vcpu} vCPU`,
        detail: `${values.fleetCount} instances at ${values.vcpu} vCPU provide ${Math.round(values.capacity).toLocaleString("en-US")} rps at 100%. Peak demand is ${Math.round(values.peakRps).toLocaleString("en-US")} rps; p99 is ${values.p99.toFixed(0)}ms and memory is ${values.memoryUtil.toFixed(0)}% utilized.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Orders database",
        kind: "db",
        health: clamp(values.peakRps / 60_000) >= 0.9 ? "warn" : "ok",
        utilization: clamp(values.peakRps / 60_000),
        throughput: Math.min(values.peakRps, values.capacity),
        sublabel: `${Math.round(Math.min(values.peakRps, values.capacity)).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.peakRps / 40_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.peakRps / 40_000), health),
      edge("fleet-db", "fleet", "db", clamp(values.peakRps / 60_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("average-cpu", "Average CPU", values.averageUtil * 100, "%", undefined, undefined, "percent"),
      metric("peak-cpu", "Peak CPU", values.peakUtil * 100, "%", 70, 85, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("memory", "Memory utilization", values.memoryUtil, "%", 80, 95, "percent"),
      metric("cost-per-mreq", "Cost per million requests", values.costPerM, " $/M req", 0.2, 0.35, "number"),
      metric("monthly-cost", "Monthly compute spend", values.monthlyCost / 1_000, " k$", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      peakEvent: 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.fleetCount} × ${values.vcpu} vCPU carry ${Math.round(values.capacity).toLocaleString("en-US")} rps. Average CPU is ${(values.averageUtil * 100).toFixed(0)}%, peak CPU ${(values.peakUtil * 100).toFixed(0)}%, p99 ${values.p99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.98 + 0.04 * Math.sin((index + (seed % 9)) / 2.4);
      return Math.max(0, item.value * wave);
    });
  }
  frame.flags.seriesSeeded = 1;
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0);
  seedSeries(frame, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "peak-cpu",
    metricId: "peak-cpu",
    warn: 70,
    crit: 85,
    title: "The downsized fleet cannot absorb the daily peak",
    cause:
      "The instance size or fleet count was chosen from average utilization. At the peak, demand is several times the average, so the same fleet runs close to or past 100%. Queueing raises p99 before errors appear.",
    fix:
      "Size against a peak percentile that matches the SLO, not the monthly average. Add memory headroom, then test the change at the peak before rolling it across the fleet.",
    checkFirst: [
      "Compare average and peak CPU for the same service.",
      "Check p99 at the peak, not only the daily average.",
      "Check memory working set and per-instance memory limits.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Peak latency breached the SLO after rightsizing",
    cause:
      "Utilization is high enough that queueing dominates service time. A smaller instance has less CPU and memory, so the same burst produces a longer wait and a larger tail.",
    fix:
      "Restore the size or count needed for the peak, or reduce the peak with admission control. Verify the fix at the same peak-to-average ratio that caused the breach.",
    checkFirst: [
      "Check p99 by instance size and by service.",
      "Check whether the peak is a burst or a sustained step.",
      "Check for memory pressure and garbage collection pauses.",
    ],
  },
  {
    id: "memory",
    metricId: "memory",
    warn: 80,
    crit: 95,
    title: "Memory is the binding constraint on the smaller instance",
    cause:
      "Concurrent requests hold working memory. A smaller instance has less memory as well as less CPU, so the same concurrency can exhaust the heap, page cache, or request buffers even when CPU looks acceptable.",
    fix:
      "Size for the memory working set at peak concurrency. If the service is memory-bound, move to a memory-optimized family instead of shrinking the compute family.",
    checkFirst: [
      "Check memory at peak concurrency, not only the average.",
      "Check for restarts, OOM kills, and garbage collection time.",
      "Check whether a memory limit is lower than the instance size.",
    ],
  },
  {
    id: "cost-per-mreq",
    metricId: "cost-per-mreq",
    warn: 0.2,
    crit: 0.35,
    title: "The fleet is oversized for its traffic",
    cause:
      "Instances are larger than the workload needs at peak, so the fleet pays for idle capacity. A very low peak utilization with a high cost per request is the signal, not a reason to celebrate low CPU.",
    fix:
      "Rightsize gradually with peak and memory evidence, or reduce the fleet count. Keep enough headroom for the largest failure domain and the ramp.",
    checkFirst: [
      "Compare cost per request across services.",
      "Check peak utilization and memory, not just the average.",
      "Check whether the fleet has failure-domain headroom that is still required.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const rightsizingModel: SimModel = {
  id: "capacity-rightsizing",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    let peakEvent = frame.flags.peakEvent === 1;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (t >= 8 && !peakEvent) {
      const values = compute(p, t);
      pushEvent(next, {
        id: "daily-peak",
        at: t,
        severity: values.peakUtil >= 0.85 ? "warn" : "info",
        title: "Daily peak demand arrived",
        detail: `Demand is ${Math.round(values.peakRps).toLocaleString("en-US")} rps against ${Math.round(values.capacity).toLocaleString("en-US")} rps of capacity. Average CPU is ${(values.averageUtil * 100).toFixed(0)}%, peak CPU ${(values.peakUtil * 100).toFixed(0)}%.`,
        nodeId: "fleet",
        metricId: "peak-cpu",
      });
      peakEvent = true;
    }

    next.flags.peakEvent = peakEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `Average CPU is ${value("average-cpu").toFixed(0)}% but peak CPU is ${value("peak-cpu").toFixed(0)}%. Size for the peak that the SLO sees`,
    ];
    if (value("p99-latency") >= 300) {
      items.push(
        `p99 is ${value("p99-latency").toFixed(0)}ms. The fleet is queueing at the peak, so the average utilization was not a safe sizing signal.`,
      );
    }
    if (value("memory") >= 80) {
      items.push(
        `Memory is ${value("memory").toFixed(0)}% utilized. A smaller instance also has less memory; check concurrency before changing the family.`,
      );
    }
    items.push(
      "Rightsize per service with peak CPU, memory, and p99 evidence. A fleet-wide percentage cannot tell you which service has the burst.",
    );
    return items;
  },
  legend: [
    { label: "Within SLO", tone: "ok" },
    { label: "Approaching limit", tone: "warn" },
    { label: "Breaching SLO", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "32 instances at 4 vCPU, a 2.4× daily peak, and about 15% average CPU.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 3.2× peak with 26 instances; CPU is above target but p99 is still under the SLO.",
    tone: "warn",
    params: defaults({ averageRps: 10_000, fleetCount: 26, peakToAverage: 3.2 }),
  },
  {
    id: "failure",
    label: "Downsized to 2 vCPU",
    description: "The fleet was halved to 2 vCPU on a 4.2× peak; CPU, memory, and p99 all breach at the peak.",
    tone: "crit",
    params: defaults({ averageRps: 10_000, fleetCount: 32, instanceVcpu: 2, peakToAverage: 4.2 }),
  },
  {
    id: "recovery",
    label: "Restore the size",
    description: "Back to 4 vCPU with 40 instances; peak and memory return inside the targets.",
    tone: "ok",
    params: defaults({ averageRps: 10_000, fleetCount: 40, instanceVcpu: 4, peakToAverage: 2.4 }),
  },
  {
    id: "oversized",
    label: "Oversized",
    description: "40 instances at 8 vCPU; latency is excellent and cost per request is far above budget.",
    tone: "crit",
    params: defaults({ averageRps: 10_000, fleetCount: 40, instanceVcpu: 8, peakToAverage: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-average-trap",
  title: "Predict what the average hid",
  simId: "rightsizing",
  question:
    "The team halved instance size because average CPU was 39%. At the daily peak, p99 breaches the SLO. What did the average hide?",
  prediction: {
    options: [
      { id: "peak", label: "A daily peak that is more than four times the average" },
      { id: "leak", label: "A slow memory leak in the new instance size" },
      { id: "network", label: "Higher network egress on smaller instances" },
      { id: "neighbor", label: "A noisy neighbor on the shared host" },
    ],
    correctOptionId: "peak",
    explanation:
      "The average is computed over the whole day. The peak is 4.2 times the average, so the fleet must carry 42,000 rps for a period even though the average is 10,000 rps. At 2 vCPU and 32 instances the fleet provides 25,600 rps, so peak utilization is above 160%. Queueing drives p99 past the SLO, and the same peak concurrency also raises memory close to the instance limit. A leak or a noisy neighbor would not track the daily peak so precisely.",
  },
  setup: defaults({ averageRps: 10_000, fleetCount: 32, instanceVcpu: 2, peakToAverage: 4.2 }),
  runFor: 30,
  observe: [
    "At the daily peak, CPU passes 100% of the 2 vCPU fleet capacity.",
    "Memory rises with peak concurrency and approaches the 4 GB limit per instance.",
    "p99 runs into the critical range while average CPU remains below 40%.",
  ],
  explain:
    "Rightsizing from an average assumes the workload is smooth. Here the peak is 4.2 times the average, so the same fleet must carry a much larger burst. A smaller instance reduces both CPU and memory, and queueing is nonlinear near saturation: p99 rises sharply before the average looks alarming. The safe move is to size against a peak percentile and memory working set, then verify at that peak.",
  fix: defaults({ averageRps: 10_000, fleetCount: 40, instanceVcpu: 4, peakToAverage: 4.2 }),
  debrief:
    "At 40 instances and 4 vCPU the fleet provides 64,000 rps, which is 66% utilization at the 42,000 rps peak. The cost rises from about $1,960 to $4,906 a month, which is the price of carrying the peak without breaking the SLO. The cheaper option was not a saving; it moved the cost into errors and latency. Prices and per-vCPU capacity are illustrative.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Rightsizing changes the shape of capacity: how many instances, how large each one is, and which instance family. It is not the same as reducing the fleet count. A smaller instance has less CPU and less memory, so a change that looks efficient on an average utilization chart can remove the burst capacity that protects the tail latency. The goal is the smallest shape that still meets the service-level objective (SLO) at the peak and survives the failure domain.",
  },
  {
    type: "p",
    text: "The average is a weak sizing signal because queueing is nonlinear. At 50% utilization a request waits a little; at 85% it waits much longer; past 100% the queue grows without bound. A fleet that averages 15% CPU can still sit above 80% for a short daily peak. Memory has the same shape: concurrent requests hold working memory, and the peak concurrency, not the average, decides whether the instance runs out. Latency is judged at p99, the 99th-percentile response time, not at the mean.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, instance fleet, and database. The instance size sets both the CPU capacity and the memory ceiling. The load balancer spreads requests across the fleet; it cannot make a saturated instance faster. The database sees the same peak, so a fleet that queues also holds connections longer and can push its own latency up.",
  },
  {
    type: "compare",
    leftTitle: "Size from the average",
    rightTitle: "Size from the peak",
    rows: [
      { label: "Signal", left: "Monthly or daily mean CPU", right: "Peak-percentile CPU, p99, and memory at concurrency" },
      { label: "Cost", left: "Lower on paper", right: "Higher, with explicit headroom" },
      { label: "Failure mode", left: "Peak queueing and memory pressure", right: "Pays for capacity that may sit idle" },
      { label: "When it fits", left: "Smooth, latency-tolerant batch work", right: "User-facing services with bursty demand" },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the gap between average and peak CPU. Apply Downsized to 2 vCPU and watch p99 and memory at the daily peak. Then try Oversized: latency is excellent and cost per request is the failure. Run the experiment before changing sliders. Per-vCPU capacity, memory per request, and prices are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Average CPU and peak CPU side by side, so the hiding effect is visible.",
      "p99 latency and memory utilization against warning and critical limits.",
      "Cost per million requests, which catches a fleet that is oversized rather than unsafe.",
      "A flow view with the fleet marked at the daily peak.",
    ],
  },
  { type: "sim", simId: "rightsizing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The downsized fleet ran at under 40% average CPU, which looked like a safe consolidation. At the daily peak the demand was 4.2 times the average, so the 2 vCPU fleet had to carry 42,000 rps with 25,600 rps of capacity. CPU passed 100%, memory approached the per-instance limit, and p99 crossed the critical threshold. The average never showed the queue because the queue only exists at the peak.",
  },
  {
    type: "p",
    text: "The oversized preset shows the opposite mistake. Forty 8 vCPU instances keep latency low and cost per million requests far above budget. Rightsizing is a two-sided problem: too small breaks the SLO, too large breaks the unit economics. The evidence needed is the same in both directions: peak utilization, memory at concurrency, p99, and cost per request.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CPU utilization averaged over the day looks low, while a five-minute peak window is near the limit.",
      "p99 latency rises at the same time each day, before the error rate moves.",
      "Memory working set and page faults rise with peak concurrency; OOM kills or restarts may follow.",
      "Cost per request is flat or improving, which makes the change look successful until the peak.",
      "Compute Optimizer or a similar tool recommends a smaller family from historical utilization; the recommendation needs peak validation.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare average and peak CPU on the same chart. Check p99 at the peak, memory at peak concurrency, and cost per request. If the peak is the problem, stop looking at the average.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Restore the previous size or count for the affected service, then confirm that p99 and memory recover at the same peak.",
      "Size against a peak percentile that matches the SLO. Use five-minute or one-minute data, not a monthly mean.",
      "Check memory at peak concurrency before changing the instance family. A compute-optimized family may have less memory per vCPU.",
      "Rightsize one service at a time, with a canary at the peak and a rollback path.",
      "Keep the headroom needed for the largest failure domain; a fleet that is merely adequate before a zone loss is underprovisioned after it.",
      "Recheck cost per request after the change so the fleet does not drift into the oversized preset.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Sizing for the peak costs money outside the peak; sizing for the average moves the cost into latency and errors.",
      "Smaller instances can improve packing efficiency but reduce the memory ceiling and the burst buffer per instance.",
      "A larger number of small instances gives finer scaling granularity but more per-instance overhead and more failure units.",
      "Burstable instance families can absorb short peaks, but sustained peaks exhaust CPU credits and change the latency profile.",
      "A slow, canaried rightsizing program costs engineering time; a fleet-wide change is faster and has a larger blast radius.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-not-everything",
    question: "Half the fleet averages 15% CPU. Why not downsize everything?",
    difficulty: 2,
    hints: [
      "The average is not the peak.",
      "CPU is not the only resource.",
    ],
    answer:
      "Because a low average can hide a short peak that sets p99, and because memory and network can bind before CPU does. I would look at peak-percentile CPU, memory at peak concurrency, p99, and the cost per request for each service. A smooth batch service might be safe to shrink; a user-facing service with a four-times daily peak may not be. The fleet-wide average also mixes services with different burst shapes, so it cannot justify a fleet-wide size change. The safe approach is per-service evidence, a canary at the peak, and a rollback path.",
    followUps: [
      "Which percentile would you use for sizing?",
      "How does the failure domain change the target?",
      "What would you measure after the change?",
    ],
    redFlags: [
      "Uses only average CPU.",
      "Assumes memory scales with CPU.",
      "Changes the whole fleet at once.",
    ],
    rubric: [
      "Names peak versus average.",
      "Includes memory and p99.",
      "Works per service.",
      "Includes validation and rollback.",
    ],
  },
  {
    id: "evidence",
    question: "What evidence do you require before approving a downsizing recommendation?",
    difficulty: 3,
    hints: [
      "A recommendation is a hypothesis, not a decision.",
      "The peak is the test case.",
    ],
    answer:
      "I want peak-window CPU and memory, p99 and error rate at that peak, the burst duration and frequency, and the instance family's limits. I also want the cost per request before and after and the headroom required for the largest failure domain. If the tool recommendation is based on average utilization, I would treat it as a candidate and test it on a canary through a real peak. The approval should name the SLO that must hold and the rollback trigger.",
    followUps: [
      "What if the peak only happens once a quarter?",
      "How would you test without waiting for the peak?",
      "Who owns the SLO during the change?",
    ],
    redFlags: [
      "Accepts the tool output without peak data.",
      "Ignores memory.",
      "Has no rollback trigger.",
    ],
    rubric: [
      "Uses peak-window data.",
      "Includes memory and SLO.",
      "Accounts for failure headroom.",
      "Defines a canary and rollback.",
    ],
  },
  {
    id: "latency-critical",
    question: "How would you rightsize a latency-critical service without risking an outage?",
    difficulty: 3,
    hints: [
      "Change one dimension at a time.",
      "The peak is the acceptance test.",
    ],
    answer:
      "I would change one dimension at a time, starting with the least risky services and one canary instance or a small percentage of traffic. I would run the canary through the daily peak or a load test that reproduces it, and compare p99, memory, CPU, and cost per request with the baseline. I would keep the old capacity available for a fast rollback and define the trigger before the change. If the service is stateful, I would also check startup, warm-up, and data placement, because a smaller instance can change all three.",
    followUps: [
      "How long would you keep the canary?",
      "What would make you stop the rollout?",
      "How do you handle a stateful service?",
    ],
    redFlags: [
      "Changes size and count together.",
      "Tests only at low traffic.",
      "No rollback capacity.",
    ],
    rubric: [
      "Changes one variable at a time.",
      "Tests at the peak.",
      "Defines rollback and triggers.",
      "Considers state and warm-up.",
    ],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "Peak-window CPU, memory, p99, and error rate are recorded for each service.",
      "The burst ratio and duration are known, not just the daily average.",
      "Memory at peak concurrency is checked against the smaller family's limit.",
      "The failure-domain headroom requirement is documented.",
      "A canary, rollback path, and acceptance threshold are agreed.",
    ],
  },
  {
    title: "During the change",
    items: [
      "Change one service and one dimension at a time.",
      "Watch p99 and memory at the peak, not only the average.",
      "Stop and roll back if p99 or memory crosses the agreed trigger.",
      "Check that the load balancer drains old instances before they are removed.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Confirm cost per request improved without a p99 regression.",
      "Check that the fleet still survives the largest failure domain.",
      "Record the peak evidence that justified the new size.",
      "Revisit the recommendation when the traffic mix or peak shape changes.",
    ],
  },
];

const references = [
  {
    title: "AWS Compute Optimizer: What is AWS Compute Optimizer?",
    url: "https://docs.aws.amazon.com/compute-optimizer/latest/ug/what-is-compute-optimizer.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rightsizing recommendations based on utilization and configuration; recommendations still need peak validation.",
  },
  {
    title: "Amazon EC2 instance types",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Families trade CPU, memory, network, and storage; a smaller size changes more than vCPU count.",
  },
  {
    title: "Amazon CloudWatch agent",
    url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Collects memory and other guest metrics that the hypervisor does not expose by default.",
  },
  {
    title: "AWS Well-Architected: Performance Efficiency Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/performance-efficiency-pillar/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Selecting and rightsizing resources against measured demand and performance requirements.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    rightsizing: {
      model: rightsizingModel,
      presets,
      instructions:
        "Start Healthy and compare average with peak CPU. Apply Downsized to 2 vCPU, then Oversized. Run the experiment before changing sliders.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Per-vCPU throughput, memory per concurrent request, prices, and the 15% baseline are teaching values, not AWS benchmarks or quotes.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-cost-per-request",
    "capacity-headroom-cost",
    "capacity-queueing-headroom",
    "capacity-warm-pools",
  ],
};
