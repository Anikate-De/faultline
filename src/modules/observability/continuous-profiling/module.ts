import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  ParamSpec,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CORES = 32;

const params: ParamSpec[] = [
  {
    id: "traffic",
    label: "Request rate",
    min: 200,
    max: 5_000,
    step: 100,
    value: 1_200,
    unit: " req/s",
    group: "Load",
    help: "Requests per second through the profiled service. CPU per request times traffic sets service utilization.",
    format: "rps",
  },
  {
    id: "release",
    label: "Release under test",
    min: 1,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Code",
    help: "1 is the previous build; 2 adds a deep copy to the serialization path. The profile difference is the evidence.",
    format: "count",
  },
  {
    id: "payloadKb",
    label: "Request payload",
    min: 1,
    max: 64,
    step: 1,
    value: 8,
    unit: " KB",
    group: "Code",
    help: "Average JSON body size. The new serialization path copies it, and allocation grows with the copy.",
    format: "count",
  },
  {
    id: "sampleHz",
    label: "Profile sample rate",
    min: 10,
    max: 100,
    step: 10,
    value: 50,
    unit: " Hz",
    group: "Profiler",
    help: "Stack samples per second per core. Higher resolution costs CPU overhead and memory.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface FunctionCost {
  name: string;
  ms: number;
}

interface Computed {
  traffic: number;
  release: number;
  payloadKb: number;
  sampleHz: number;
  jsonMs: number;
  gcMs: number;
  totalMs: number;
  functions: FunctionCost[];
  hotName: string;
  hotShare: number;
  utilization: number;
  serviceCpu: number;
  p99: number;
  overhead: number;
}

function compute(p: Params): Computed {
  const traffic = Math.round(num(p, "traffic", 1_200));
  const release = Math.round(num(p, "release", 1));
  const payloadKb = Math.round(num(p, "payloadKb", 8));
  const sampleHz = Math.round(num(p, "sampleHz", 50));
  const isNew = release >= 2;
  const jsonMs = 0.9 + payloadKb * (isNew ? 0.09 : 0.02);
  const gcMs = payloadKb * 0.03 * (isNew ? 1.6 : 1);
  const functions: FunctionCost[] = [
    { name: "http.serve", ms: 1.2 },
    { name: "auth", ms: 0.5 },
    { name: "json.dec", ms: 1.0 },
    { name: "json.enc", ms: jsonMs },
    { name: "db.ser", ms: 0.6 },
    { name: "tpl.render", ms: 0.7 },
    { name: "gc", ms: gcMs },
    { name: "metrics", ms: 0.3 },
  ];
  const totalMs = functions.reduce((sum, item) => sum + item.ms, 0);
  const hottest = functions.reduce((best, item) => (item.ms > best.ms ? item : best), functions[0]);
  const utilization = (traffic * totalMs) / 1_000 / CORES;
  const serviceCpu = Math.min(100, utilization * 100);
  const p99 = Math.min(3_000, 45 + 20 * Math.min(1, utilization) + Math.max(0, utilization - 0.9) * 9_000);
  return {
    traffic,
    release,
    payloadKb,
    sampleHz,
    jsonMs,
    gcMs,
    totalMs,
    functions,
    hotName: hottest.name,
    hotShare: (hottest.ms / totalMs) * 100,
    utilization,
    serviceCpu,
    p99,
    overhead: sampleHz * 0.08,
  };
}

function healthFromCpu(value: number): Health {
  if (value >= 90) return "crit";
  if (value >= 70) return "warn";
  return "ok";
}

function healthFromOverhead(value: number): Health {
  if (value >= 8) return "crit";
  if (value >= 6) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["service-cpu", values.serviceCpu, 1.2],
    ["cpu-per-request", values.totalMs, 0.08],
    ["hot-function-share", values.hotShare, 0.8],
    ["p99", values.p99, 8],
    ["profiler-overhead", values.overhead, 0.1],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 12)) / 2.7) * amplitude),
    );
  }
  for (const item of values.functions) {
    const share = (item.ms / values.totalMs) * values.serviceCpu;
    frame.series[`cpu.${item.name}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, share + Math.sin((index + (seed % 5)) / 2.4) * Math.max(0.05, share * 0.03)),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const serviceHealth = healthFromCpu(values.serviceCpu);
  const agentHealth = healthFromOverhead(values.overhead);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        throughput: values.traffic,
        sublabel: `${values.traffic} req/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(values.serviceCpu / 100),
        throughput: values.traffic,
        sublabel: `${values.serviceCpu.toFixed(0)}% CPU, ${values.totalMs.toFixed(1)}ms/req`,
        detail: `Release ${values.release}, ${values.payloadKb}KB payload. ${values.hotName} accounts for ${values.hotShare.toFixed(0)}% of CPU self time.`,
        meta: { view: "flow" },
      },
      {
        id: "agent",
        label: "Profiler agent",
        kind: "service",
        health: agentHealth,
        sublabel: `${values.sampleHz} Hz per core`,
        detail: "Samples stacks in-process at a fixed rate. Overhead is illustrative; the profile aggregates over minutes.",
        meta: { view: "flow" },
      },
      {
        id: "store",
        label: "Profile store",
        kind: "storage",
        health: "ok",
        sublabel: "flame graphs by release",
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "client-service", from: "client", to: "service", rate: 1, health: serviceHealth },
      { id: "service-agent", from: "service", to: "agent", rate: 1, health: serviceHealth },
      { id: "agent-store", from: "agent", to: "store", rate: 1, health: agentHealth },
    ],
    metrics: [
      metric("service-cpu", "Service CPU", values.serviceCpu, "%", 70, 90, "percent"),
      metric("cpu-per-request", "CPU per request", values.totalMs, "ms", 8, 12, "ms"),
      metric("hot-function-share", "Hottest function self time", values.hotShare, "%", 25, 35, "percent"),
      metric("p99", "Request p99", values.p99, "ms", 300, 800, "ms"),
      metric("profiler-overhead", "Profiler overhead", values.overhead, "%", 6, 8, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, cores: CORES },
    summary: `${values.hotName} holds ${values.hotShare.toFixed(0)}% of CPU self time; service at ${values.serviceCpu.toFixed(0)}% CPU; p99 ${values.p99.toFixed(0)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "service-cpu",
    metricId: "service-cpu",
    warn: 70,
    crit: 90,
    title: "Service CPU is at its capacity limit",
    cause: "CPU per request multiplied by request rate exceeds the cores available. The service queues work, so latency rises even if the application is not blocked on a dependency.",
    fix: "Find the function that consumes self time before adding capacity. A profile attributes CPU to stack frames; service metrics can only tell you which service is hot.",
    checkFirst: [
      "Compare CPU per request with the previous release.",
      "Open the flame graph for the service and sort by self time.",
      "Check whether allocation and garbage collection explain part of the rise.",
    ],
  },
  {
    id: "hot-function-share",
    metricId: "hot-function-share",
    warn: 25,
    crit: 35,
    title: "One function dominates CPU self time",
    cause: "A code path inside the service consumes a large share of samples. The concentration is invisible in request traces because a trace shows elapsed time, not CPU attribution.",
    fix: "Inspect the hot frame and its callers. Remove redundant work, reduce copies, or move the work off the request path. Diff the profile against the previous release to confirm the regression.",
    checkFirst: [
      "Open the flame graph and read the widest self-time frame.",
      "Compare the same frame in the previous release profile.",
      "Check whether the function's cost scales with payload size.",
    ],
  },
  {
    id: "cpu-per-request",
    metricId: "cpu-per-request",
    warn: 8,
    crit: 12,
    title: "CPU per request has regressed",
    cause: "The service now does more work for the same request. The cause can be a copy, serialization, an extra pass over data, or allocation that triggers collection.",
    fix: "Diff profiles by release and look for the frame whose self time grew. Fix the code path, then verify CPU per request returns to the old baseline before raising traffic.",
    checkFirst: [
      "Compare CPU per request before and after the release.",
      "Check payload-size sensitivity in the profile.",
      "Check allocation rate and GC share.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Request latency is above the SLO",
    cause: "The service is at or beyond its CPU capacity, so requests wait for a core. The p99 rises nonlinearly once utilization approaches the limit.",
    fix: "Reduce CPU per request or add capacity. Use the profile to find the work, and use traces to confirm which requests wait. Do not tune the latency percentiles without changing the work.",
    checkFirst: [
      "Check whether p99 rises with traffic or with a new release.",
      "Compare service CPU with p99 on the same timeline.",
      "Open a slow trace and a profile from the same minute.",
    ],
  },
  {
    id: "profiler-overhead",
    metricId: "profiler-overhead",
    warn: 6,
    crit: 8,
    title: "Profiling overhead is material",
    cause: "A high sample rate consumes CPU and memory in the process it is measuring. The observer becomes part of the load.",
    fix: "Lower the sample rate for steady-state collection or enable profiling for a bounded window at higher resolution.",
    checkFirst: [
      "Compare CPU with profiling on and off.",
      "Check the sample rate per service and environment.",
      "Check whether profiling is running continuously at maximum resolution.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const profilingModel: SimModel = {
  id: "observability-continuous-profiling",
  visual: "heatmap",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "service-cpu" || item.id === "p99"
        ? { ...item, value: Math.max(0, item.value * (1 + jitter)) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const item of values.functions) {
      recordSeries(next, `cpu.${item.name}`, (item.ms / values.totalMs) * values.serviceCpu);
    }
    if (values.hotShare >= 25 && frame.flags.hotFunctionSeen !== 1) {
      pushEvent(next, {
        id: "serialization-hotspot",
        at: frame.t,
        severity: "warn",
        title: "One function dominates the CPU profile",
        detail: `${values.hotName} holds ${values.hotShare.toFixed(0)}% of self time after release ${values.release}. Service CPU is ${values.serviceCpu.toFixed(0)}% and p99 is ${values.p99.toFixed(0)}ms.`,
        nodeId: "service",
        metricId: "hot-function-share",
      });
      next.flags.hotFunctionSeen = 1;
    }
    if (values.hotShare < 25) next.flags.hotFunctionSeen = 0;
    next.summary = `${values.hotName} holds ${values.hotShare.toFixed(0)}% of CPU self time; service at ${values.serviceCpu.toFixed(0)}% CPU; p99 ${values.p99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const gc = values.functions.find((item) => item.name === "gc");
    return [
      `${values.traffic} req/s × ${values.totalMs.toFixed(2)}ms = ${((values.traffic * values.totalMs) / 1_000).toFixed(1)} cores of demand on ${CORES} cores, or ${values.serviceCpu.toFixed(0)}% utilization.`,
      `${values.hotName} is ${values.hotShare.toFixed(0)}% of self time (${values.functions.find((item) => item.name === values.hotName)?.ms.toFixed(2)}ms per request). That is a CPU attribution, not a trace duration.`,
      `json.enc costs ${values.jsonMs.toFixed(2)}ms and gc costs ${gc?.ms.toFixed(2)}ms per request after release ${values.release}; both scale with the ${values.payloadKb}KB payload.`,
      `db.ser holds ${((values.functions.find((item) => item.name === "db.ser")?.ms ?? 0) / values.totalMs * 100).toFixed(0)}% of self time. A database span can still dominate total time while using little CPU.`,
      `The profiler adds about ${values.overhead.toFixed(1)}% CPU at ${values.sampleHz} Hz. Higher resolution improves short-frame evidence and raises the observer cost.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Hot", tone: "warn" },
    { label: "Saturated", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Release 1 at 1,200 req/s and 8KB payloads. CPU is 21% and no function dominates.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Traffic peak",
    description: "3,900 req/s on the old release. Service CPU warns at 71%; the profile still shows a spread of functions.",
    tone: "warn",
    params: defaults({ traffic: 3_900, payloadKb: 12 }),
  },
  {
    id: "failure",
    label: "New serialization path",
    description: "Release 2 deep-copies a 40KB payload at 3,000 req/s. CPU, p99, and the hot function cross critical.",
    tone: "crit",
    params: defaults({ traffic: 3_000, release: 2, payloadKb: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Roll back to release 1 at the same 3,000 req/s and 40KB payload. CPU falls to 68% and p99 to 58ms.",
    tone: "ok",
    params: defaults({ traffic: 3_000, release: 1, payloadKb: 40 }),
  },
];

const experiment: Experiment = {
  id: "predict-hot-function",
  title: "Predict where the CPU went",
  simId: "continuous-profiling",
  question:
    "After release 2, CPU per request rises by about 50% at a 40KB payload. Traces show the checkout span slow, but every downstream call looks normal. Where is the CPU?",
  prediction: {
    options: [
      { id: "json", label: "json.enc, the JSON encoder, which deep-copies the payload on the request path" },
      { id: "db", label: "db.ser, because the database span is the longest" },
      { id: "auth", label: "auth, because token checks always dominate CPU" },
      { id: "network", label: "The network stack, which retransmits large bodies" },
    ],
    correctOptionId: "json",
    explanation:
      "A trace shows elapsed time, not CPU attribution. The database span can be long because it waits, while its self CPU stays small. Sampling the stack in-process shows which frame is on the CPU: the new deep copy in json.enc, plus the allocation it creates.",
  },
  setup: defaults({ traffic: 3_000, release: 2, payloadKb: 40 }),
  runFor: 20,
  observe: [
    "Service CPU reaches about 100% and p99 crosses one second.",
    "json.enc holds about 42% of self time and is the darkest row in the heat map.",
    "db.ser stays flat at 0.6ms of self time even though its traces can be long.",
    "GC share rises with the copy, so the allocation path is part of the same regression.",
  ],
  explain:
    "The profile aggregates stack samples over time. Each sample attributes CPU to the frame at the top of the stack, so the width of a frame is the share of samples spent there. The deep copy appears as self time in json.enc; the allocation it creates appears later as garbage collection. Neither is visible in a service-level CPU number or a span duration.",
  fix: defaults({ traffic: 3_000, release: 1, payloadKb: 40 }),
  debrief:
    "Rolling back removes the copy and returns CPU per request to 7.2ms, service CPU to 68%, and p99 to 58ms at the same traffic and payload. That is back below the warning line without reducing load. The profile was the evidence that located the regression; the rollback was the fix. The next step is a code change that encodes without the extra copy, verified against the same profile diff.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A continuous profiler samples the call stack of a running process at a fixed rate. Each sample records which function was executing, including its callers. Aggregated over minutes, the samples become a profile: a flame graph where width is the share of samples and the top frame is where CPU was spent. The process keeps serving traffic, and the overhead is a controlled cost.",
  },
  {
    type: "p",
    text: "The key reading is self time. A function's total time includes everything it calls; its self time is the samples where it was the top frame. A database client can appear wide in a trace because it waits for a response, while its self time in a CPU profile is small. That difference is why a profile can point at serialization when the trace points at the database.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Metrics tell you which service is hot. Traces tell you which request and which span. A profile tells you which function and call path inside that service. The agent runs in-process, ships samples to a profile store, and lets you compare two time ranges or two releases. Allocation profiles use the same sampling idea to attribute memory growth rather than CPU.",
  },
  {
    type: "table",
    headers: ["Signal", "Answers", "Cannot answer"],
    rows: [
      ["Service metric", "Which service is at high CPU or latency", "Which function inside it is responsible"],
      ["Trace", "Which request waited, and on which span", "How much CPU the waiting span actually used"],
      ["CPU profile", "Which frames consumed samples", "Which users or requests were affected"],
      ["Allocation profile", "Which frames allocate memory", "Whether the allocation is retained or short-lived"],
    ],
  },
  {
    type: "p",
    text: "The heat map abbreviates frame labels: `json.enc` is JSON encoding, `json.dec` is JSON decoding, `db.ser` is the database serializer, and `tpl.render` is template rendering.",
  },
  {
    type: "p",
    text: "The numbers in this model are illustrative. The service has 32 cores, a fixed set of functions, and a sampling overhead that grows with the rate. The shape is the lesson: CPU per request times traffic determines utilization, and a profile attributes that CPU to frames. A single hot frame can consume more than a third of the total.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Service CPU and CPU per request, which show that work grew but not where.",
      "Hottest function self time, the concentration a profile exposes.",
      "Request p99, which rises nonlinearly as utilization approaches the core limit.",
      "A heat map of functions over time, so the release change is visible as a row that darkens.",
      "Profiler overhead, the cost of collecting the evidence at the chosen sample rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the even spread in the heat map. Apply New serialization path and watch json.enc become the darkest row while db.ser stays flat. Compare with Traffic peak, where CPU rises but no single function dominates. Run the experiment before reading the debrief.",
  },
  { type: "sim", simId: "continuous-profiling" },
  { type: "experiment", experimentId: "predict-hot-function" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Release 2 added a deep copy to the serialization path. At a 40KB payload, CPU per request rose from 7.2ms to 10.7ms, and at 3,000 req/s the service needed more than the 32 cores available. Service CPU reached 100%, p99 crossed one second, and json.enc became 42% of self time. The metric and the trace both showed a slow service, but neither named the function.",
  },
  {
    type: "p",
    text: "The profile did. Sampling the stack attributed the extra work to json.enc and, through allocation, to gc. The database frame stayed at 0.6ms of self time even though a database span can still dominate a trace's elapsed time. Rolling back removed the copy and restored the baseline. The profile is evidence for a code change, not a fix by itself.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CPU flame graph: the widest self-time frame and its callers, with the release or time range labeled.",
      "Profile diff: the same frame growing between two releases or two hours.",
      "Allocation profile: allocation rate by frame, often pointing at a copy or a buffer.",
      "Service metrics: CPU per request and utilization, which show the regression but not its location.",
      "Traces: the slow span and the waiting time, which tell you where to look but not which frame burned the CPU.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Diff the profile by release before reading code. Find the widest self-time frame that grew, check whether its cost scales with payload size, and compare it with the allocation profile. Then confirm with one trace from the same minute that the request path matches the profile.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the regression: roll back the release if CPU is at capacity and the change is not understood.",
      "Diff the profile against the previous release and name the frame whose self time grew.",
      "Remove the redundant copy or pass a reference through the serialization path instead.",
      "Check the allocation profile and reduce buffer or object churn that drives garbage collection.",
      "Verify CPU per request against the old baseline at the same payload size.",
      "Re-run the load at peak and confirm utilization, p99, and the hot-frame share together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Profiling costs CPU and memory in the process it measures; a high sample rate during an incident can add load.",
      "A profile attributes CPU, not wall time. A waiting function is not a hot frame, and a hot frame may not be the user-visible bottleneck.",
      "Continuous profiles are sampled, so very short functions need a higher rate or longer aggregation to appear.",
      "Rollback is fast and loses the new feature; a code fix keeps the feature and needs review and verification.",
      "Comparing releases requires stable labels and retention long enough to cover the previous deploy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-flame-graph",
    question:
      "A flame graph shows a wide database frame and a narrow serialization frame. The trace says the database span is the slowest. Which one is burning CPU?",
    difficulty: 3,
    hints: [
      "Width in a CPU profile is samples, not elapsed time.",
      "Waiting does not consume a core.",
    ],
    answer:
      "The wide database frame in a CPU profile would mean samples were on the CPU inside that code, not waiting on the network. But a database span in a trace is mostly wait time, so it should be narrow in a CPU profile. If the database frame is narrow and serialization is narrow too, I would look at the callers and the total frame widths. The trace tells me which span the request waited on; the profile tells me which frames used the core. I need both to avoid optimizing a wait.",
    followUps: [
      "What would a wide database frame mean?",
      "How does an allocation profile change the answer?",
      "Why can a narrow frame still be the cause of a latency regression?",
    ],
    redFlags: [
      "Equates span duration with CPU time.",
      "Ignores wait time.",
      "Optimizes the widest frame without checking the trace.",
    ],
    rubric: [
      "Separates elapsed time from CPU.",
      "Reads self time.",
      "Uses both trace and profile.",
      "Names the wait-versus-work distinction.",
    ],
  },
  {
    id: "profile-release",
    question:
      "How do you use continuous profiling to confirm that a release caused a CPU regression?",
    difficulty: 3,
    hints: [
      "Compare the same frame across time ranges.",
      "Keep traffic and payload comparable.",
    ],
    answer:
      "I would compare the profile for the release window with the same service and traffic profile before the deploy. I would look for a frame whose self time grew, not just a higher total CPU. Then I would check whether the growth scales with payload size or request mix, and whether the allocation profile shows a matching increase. A release diff plus a reproducible load is much stronger evidence than a single flame graph taken during an incident.",
    followUps: [
      "What if traffic changed at the same time?",
      "How long do you retain profiles for comparison?",
      "What would falsify the release hypothesis?",
    ],
    redFlags: [
      "Compares two different traffic levels.",
      "Looks only at total CPU.",
      "Ignores allocation.",
    ],
    rubric: [
      "Compares same service and load.",
      "Reads self-time growth.",
      "Checks payload sensitivity.",
      "Names a falsifier.",
    ],
  },
  {
    id: "profiling-overhead",
    question:
      "Continuous profiling is always on at 100Hz. What could go wrong, and how would you change the policy?",
    difficulty: 2,
    hints: [
      "The observer runs inside the process.",
      "Resolution and cost are linked.",
    ],
    answer:
      "The profiler consumes CPU and memory in the process it measures, so at a high rate it can add measurable load and memory pressure. I would set a lower steady-state rate, use a higher rate only for a bounded investigation window, and check the overhead against the service's own CPU. I would also verify that the profile store can handle the volume and that retention covers a release comparison. The right rate depends on the shortest frame we need to see.",
    followUps: [
      "How would you measure the overhead?",
      "Which services should keep profiling on continuously?",
      "What does a lower rate cost you in evidence?",
    ],
    redFlags: [
      "Assumes profiling is free.",
      "Runs the maximum rate continuously.",
      "Ignores memory and storage.",
    ],
    rubric: [
      "Names CPU and memory cost.",
      "Separates steady state from investigation.",
      "Connects rate to resolution.",
      "Measures overhead.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every critical service emits CPU and allocation profiles with a release label.",
      "Profiles are retained long enough to compare with the previous deploy.",
      "The team knows how to read self time versus total time.",
      "The steady-state sample rate is documented with its measured overhead.",
      "A load test can reproduce the traffic and payload mix.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Diff the profile by release before reading code.",
      "Find the widest self-time frame and check its callers.",
      "Compare the CPU profile with the allocation profile.",
      "Confirm with a trace from the same minute that the path matches.",
      "Roll back if the service is at capacity and the change is not understood.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify CPU per request and p99 at the original load.",
      "Fix the hot frame and re-diff the profile.",
      "Reduce allocation churn if GC contributed.",
      "Add a release gate for CPU per request on a fixed payload.",
      "Review the sample rate and retention against the evidence needs.",
    ],
  },
];

const references = [
  {
    title: "Pyroscope",
    url: "https://grafana.com/docs/pyroscope/latest/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Continuous profiling, flame graphs, and comparing profiles across time.",
  },
  {
    title: "Continuous Profiler",
    url: "https://docs.datadoghq.com/profiler/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Always-on CPU and allocation profiles, flame graphs, and code-level attribution.",
  },
  {
    title: "Profiles",
    url: "https://opentelemetry.io/docs/concepts/signals/profiles/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "The profiles signal and how sampled stack data relates to metrics and traces.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "continuous-profiling": {
      model: profilingModel,
      presets,
      instructions:
        "Start Healthy and read the spread of functions. Apply New serialization path and find the row that darkens. Compare with Traffic peak, then roll back.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. The 32 cores, function set, 5.6ms baseline, and sampling overhead are teaching values, not profiler limits. The heat map is a function-level view, not a full flame graph.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-trace-critical-path",
    "observability-distributed-tracing",
    "observability-golden-signals",
    "observability-rum-web-vitals",
  ],
};
