import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "targetRate",
    label: "Intended request rate",
    min: 100,
    max: 5_000,
    step: 100,
    value: 1_000,
    unit: " rps",
    group: "Load",
    help: "Requests per second the test intends to send. Open-loop generators keep this rate even during a stall.",
    format: "rps" as const,
  },
  {
    id: "stallEvery",
    label: "Stall interval",
    min: 5,
    max: 120,
    step: 5,
    value: 60,
    unit: " s",
    group: "Stall",
    help: "Seconds between injected service stalls. The fraction of time stalled is duration divided by interval.",
    format: "number" as const,
  },
  {
    id: "stallDurationMs",
    label: "Stall duration",
    min: 100,
    max: 8_000,
    step: 100,
    value: 100,
    unit: "ms",
    group: "Stall",
    help: "How long the service stops making progress during each stall.",
    format: "ms" as const,
  },
  {
    id: "loopMode",
    label: "Generator loop (0 closed, 1 open)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Measurement",
    help: "Closed loop waits for each response before issuing the next request. Open loop sends at the intended rate regardless of responses.",
    format: "count" as const,
  },
  {
    id: "correction",
    label: "Intended-arrival correction",
    min: 0,
    max: 100,
    step: 10,
    value: 100,
    unit: "%",
    group: "Measurement",
    help: "Share of closed-loop samples measured from their intended start time instead of their actual send time. HdrHistogram-style correction uses the intended arrival.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  targetRate: number;
  stallEvery: number;
  stallMs: number;
  openLoop: boolean;
  correction: number;
  affectedShare: number;
  reportedP99: number;
  correctedP99: number;
  gap: number;
  achievedRate: number;
  shortfall: number;
  omittedPerStall: number;
  intendedP99: number;
}

function compute(p: Params): Computed {
  const targetRate = Math.max(1, num(p, "targetRate", 1_000));
  const stallEvery = Math.max(1, num(p, "stallEvery", 60));
  const stallMs = Math.max(1, num(p, "stallDurationMs", 100));
  const openLoop = Math.round(num(p, "loopMode", 0)) >= 1;
  const correction = clamp(num(p, "correction", 100), 0, 100);
  const stallSeconds = stallMs / 1_000;
  const affectedShare = Math.min(0.9, stallSeconds / stallEvery);
  const baseP99 = 120;
  const intendedP99 = affectedShare >= 0.01 ? Math.max(baseP99, stallMs) : baseP99;
  const reportedP99 = openLoop ? intendedP99 : baseP99;
  const correctedP99 = openLoop ? reportedP99 : reportedP99 + (intendedP99 - reportedP99) * (correction / 100);
  const achievedRate = openLoop ? targetRate : targetRate * (1 - affectedShare);
  return {
    targetRate,
    stallEvery,
    stallMs,
    openLoop,
    correction,
    affectedShare,
    reportedP99,
    correctedP99,
    gap: correctedP99 / Math.max(1, reportedP99),
    achievedRate,
    shortfall: ((targetRate - achievedRate) / targetRate) * 100,
    omittedPerStall: openLoop ? 0 : targetRate * stallSeconds,
    intendedP99,
  };
}

function healthFor(p99: number): "ok" | "warn" | "crit" {
  if (p99 >= 1_500) return "crit";
  if (p99 >= 500) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 9)) / 2.6);
  const entries: [string, number, number][] = [
    ["reported-p99", values.reportedP99, 4],
    ["corrected-p99", values.correctedP99, 12],
    ["p99-gap", values.gap, 0.2],
    ["achieved-rps", values.achievedRate, 20],
    ["omitted", values.omittedPerStall, 20],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3 + value) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const stallHealth = v.affectedShare >= 0.05 ? "crit" : v.affectedShare >= 0.02 ? "warn" : "ok";
  const generatorHealth = v.shortfall >= 15 ? "crit" : v.shortfall >= 5 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "generator",
        label: "Load generator",
        kind: "client",
        health: generatorHealth,
        utilization: clamp(v.achievedRate / Math.max(1, v.targetRate)),
        throughput: v.achievedRate,
        sublabel: `${v.openLoop ? "open loop" : "closed loop"}, ${Math.round(v.achievedRate).toLocaleString()} rps`,
        detail: `Intended rate is ${Math.round(v.targetRate).toLocaleString()} rps. ${v.openLoop ? "Open-loop arrivals continue during a stall." : "Closed-loop arrivals pause while a response is outstanding."}`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service under test",
        kind: "service",
        health: stallHealth,
        utilization: clamp(v.affectedShare),
        throughput: v.achievedRate,
        sublabel: `stalls ${(v.affectedShare * 100).toFixed(1)}% of time`,
        detail: `A ${Math.round(v.stallMs)}ms stall every ${Math.round(v.stallEvery)}s. During the stall the service makes no progress.`,
        meta: { view: "flow" },
      },
      {
        id: "queue",
        label: "Waiting arrivals",
        kind: "queue",
        health: stallHealth,
        utilization: clamp(v.affectedShare),
        throughput: v.targetRate,
        sublabel: `${Math.round(v.omittedPerStall).toLocaleString()} omitted per stall`,
        detail: "In a closed loop these requests are never sent, so their wait is never recorded. In an open loop they wait and their latency is measured.",
        meta: { view: "flow" },
      },
      {
        id: "reporter",
        label: "Reported p99",
        kind: "service",
        health: healthFor(v.reportedP99),
        utilization: clamp(v.reportedP99 / 1_500),
        sublabel: `${v.reportedP99.toFixed(0)}ms`,
        detail: "The number a closed-loop generator reports. During a stall it has no samples to record.",
        meta: { view: "flow" },
      },
      {
        id: "corrector",
        label: "Corrected p99",
        kind: "service",
        health: healthFor(v.correctedP99),
        utilization: clamp(v.correctedP99 / 1_500),
        sublabel: `${v.correctedP99.toFixed(0)}ms`,
        detail: `Measured against intended arrival time at ${Math.round(v.correction)}% correction. This is the latency a request would have seen if it had been sent on schedule.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("generator-service", "generator", "service", clamp(v.achievedRate / Math.max(1, v.targetRate)), stallHealth),
      edge("service-queue", "service", "queue", clamp(v.affectedShare), stallHealth),
      edge("queue-reporter", "queue", "reporter", clamp(v.affectedShare), stallHealth),
      edge("queue-corrector", "queue", "corrector", clamp(v.affectedShare), stallHealth),
    ],
    metrics: [
      metric("reported-p99", "Reported p99", v.reportedP99, "ms", 300, 1_000, "ms"),
      metric("corrected-p99", "Corrected p99", v.correctedP99, "ms", 500, 1_500, "ms"),
      metric("p99-gap", "Reported vs corrected gap", v.gap, "x", 3, 10, "number"),
      metric("achieved-rps", "Achieved rate", v.achievedRate, " rps", undefined, undefined, "rps"),
      metric("rate-shortfall", "Rate shortfall", v.shortfall, "%", 5, 15, "percent"),
      metric("omitted", "Samples omitted per stall", v.omittedPerStall, "", 500, 2_000, "count"),
      metric("stall-share", "Time stalled", v.affectedShare * 100, "%", 2, 10, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), omissionDetected: 0 },
    summary: `Reported p99 ${v.reportedP99.toFixed(0)}ms, corrected ${v.correctedP99.toFixed(0)}ms; ${v.shortfall.toFixed(1)}% rate shortfall.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "corrected-p99",
    metricId: "corrected-p99",
    warn: 500,
    crit: 1_500,
    title: "The corrected tail is far above the reported tail",
    cause:
      "A closed-loop generator stops issuing requests while a response is outstanding. During a stall it sends nothing, so the requests that would have waited are never sampled. Measuring from intended arrival time restores them.",
    fix:
      "Report both latencies and trust the corrected one for user impact. Re-run with an open-loop generator or apply intended-arrival correction before using the result for capacity.",
    checkFirst: [
      "Check whether the generator is open loop or closed loop.",
      "Check whether the latency timestamp starts at actual send or intended arrival.",
      "Check whether the reported rate fell during the stall.",
    ],
  },
  {
    id: "p99-gap",
    metricId: "p99-gap",
    warn: 3,
    crit: 10,
    title: "Reported and corrected p99 disagree by more than an order of magnitude",
    cause:
      "The gap is the measurement bias. A large gap means the generator spent a meaningful share of time stalled and did not record the requests it failed to issue.",
    fix:
      "Treat the reported number as incomplete. Use the corrected distribution, and fix the generator or the workload model so it keeps sending at the intended rate.",
    checkFirst: [
      "Compare the achieved rate with the target rate during the stall.",
      "Check the stall duration as a fraction of the test window.",
      "Check whether the generator waits for each response before sending the next.",
    ],
  },
  {
    id: "omitted",
    metricId: "omitted",
    warn: 500,
    crit: 2_000,
    title: "Thousands of intended requests were never sampled",
    cause:
      "At the target rate, every second of stall omits more requests than the histogram can recover. The missing samples are exactly the slow ones.",
    fix:
      "Use an open-loop arrival schedule or correct each sample to its intended start time. Report the omitted count next to the percentile.",
    checkFirst: [
      "Multiply the target rate by the stall duration in seconds.",
      "Compare the omitted count with the sample count in the histogram.",
      "Check whether the test's percentile is stable when the stall duration changes.",
    ],
  },
  {
    id: "rate-shortfall",
    metricId: "rate-shortfall",
    warn: 5,
    crit: 15,
    title: "The generator did not achieve its intended request rate",
    cause:
      "A closed-loop generator loses throughput whenever it waits on a slow response. The shortfall is the time it spent not sending requests.",
    fix:
      "Do not use achieved throughput as a proxy for offered load. Keep the intended schedule independent of responses so the test measures the service, not the generator's patience.",
    checkFirst: [
      "Compare intended and achieved rates over the same window.",
      "Check whether the shortfall aligns with the stall intervals.",
      "Check whether the generator has enough connections to sustain the target.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const coordinatedOmissionModel: SimModel = {
  id: "foundations-coordinated-omission",
  visual: "flow",
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
    const key = JSON.stringify(p);
    const changed = frame.flags.paramsKey !== key;
    next.flags = { ...frame.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (changed && frame.t <= 0.11) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = frame.series;
    }
    const jitter = rng.between(-0.002, 0.002);
    next.metrics = next.metrics.map((item) =>
      item.id === "achieved-rps" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (!values.openLoop && values.reportedP99 < 300 && values.correctedP99 >= 1_500 && frame.flags.omissionDetected !== 1) {
      pushEvent(next, {
        id: "omission-detected",
        at: frame.t,
        severity: "warn",
        title: "Closed-loop p99 looks healthy while the corrected tail explodes",
        detail: `Reported p99 is ${values.reportedP99.toFixed(0)}ms, corrected p99 is ${values.correctedP99.toFixed(0)}ms. The generator omitted ${Math.round(values.omittedPerStall).toLocaleString()} intended requests per stall.`,
        nodeId: "corrector",
        metricId: "corrected-p99",
      });
      next.flags.omissionDetected = 1;
    }
    if (values.openLoop || values.correctedP99 < 500) next.flags.omissionDetected = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `Reported p99 ${values.reportedP99.toFixed(0)}ms, corrected ${values.correctedP99.toFixed(0)}ms; ${values.shortfall.toFixed(1)}% rate shortfall.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `The generator intends ${Math.round(v.targetRate).toLocaleString()} rps and achieves ${Math.round(v.achievedRate).toLocaleString()} rps in ${v.openLoop ? "open loop" : "closed loop"}.`,
      `Reported p99 is ${v.reportedP99.toFixed(0)}ms; corrected p99 is ${v.correctedP99.toFixed(0)}ms (${v.gap.toFixed(1)}x gap).`,
      `${(v.affectedShare * 100).toFixed(1)}% of time is stalled; ${Math.round(v.omittedPerStall).toLocaleString()} intended requests are omitted per stall.`,
    ];
    if (!v.openLoop && v.correctedP99 > v.reportedP99 * 3) {
      items.push("The reported percentile is measuring the generator's idle time, not the latency of the requests users would have sent.");
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
    description: "A 100ms micro-stall every 60s. The test is closed loop and corrected; the effect is small.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "An 800ms stall every 30s. Reported p99 stays at 120ms; corrected p99 is 800ms.",
    tone: "warn",
    params: defaults({ targetRate: 1_500, stallDurationMs: 800, correction: 100 }),
  },
  {
    id: "failure",
    label: "Hidden stall",
    description: "A 4s stall every 30s in a closed loop. Reported p99 is 120ms and corrected p99 is 4s.",
    tone: "crit",
    params: defaults({ targetRate: 1_000, stallEvery: 30, stallDurationMs: 4_000, loopMode: 0, correction: 100 }),
  },
  {
    id: "open-loop",
    label: "Open loop",
    description: "The same 4s stall with an open-loop generator. The reported p99 now shows the stall; the service is still failing.",
    tone: "crit",
    params: defaults({ targetRate: 1_000, stallEvery: 30, stallDurationMs: 4_000, loopMode: 1, correction: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The stall is reduced to 200ms and the generator is open loop. The tail is measured honestly and stays inside the SLO.",
    tone: "ok",
    params: defaults({ targetRate: 1_000, stallEvery: 30, stallDurationMs: 200, loopMode: 1, correction: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-corrected",
  title: "Predict what the corrected percentile shows",
  simId: "coordinated-omission",
  question:
    "A closed-loop test reports p99 120ms, but the service stalls for 4 seconds every 30. What does the corrected p99 show?",
  prediction: {
    options: [
      { id: "same", label: "About 120ms; the service is healthy" },
      { id: "stall", label: "About 4s, because intended arrivals waited through the stall" },
      { id: "middle", label: "About 500ms, the average of fast and stalled requests" },
      { id: "lower", label: "Lower than 120ms because the generator sent fewer requests" },
    ],
    correctOptionId: "stall",
    explanation:
      "The corrected sample measures each request from the time it should have been sent, not the time the generator actually sent it. A request that should have arrived at the start of the stall waits about four seconds. The closed-loop report omitted those requests entirely.",
  },
  setup: defaults({ targetRate: 1_000, stallEvery: 30, stallDurationMs: 4_000, loopMode: 0, correction: 100 }),
  runFor: 20,
  observe: [
    "Reported p99 stays near 120ms in both the metric and the reporter node.",
    "Corrected p99 jumps to 4,000ms and the gap ratio reaches about 33x.",
    "The achieved rate falls to about 867 rps, a 13% shortfall from the intended 1,000 rps.",
    "About 4,000 intended requests are omitted per stall, which is exactly the 1,000 rps target times four seconds.",
  ],
  explain:
    "The generator is not lying on purpose. A closed loop waits for a response before sending the next request, so a stalled service naturally reduces the number of outstanding requests. The requests that would have arrived during the stall are never created, so they cannot be sampled. Correcting the start time restores the missing wait, and the tail becomes 4 seconds.",
  fix: defaults({ targetRate: 1_000, stallEvery: 30, stallDurationMs: 200, loopMode: 1, correction: 100 }),
  debrief:
    "The recovery does two things: it reduces the service stall and it removes the measurement bias by using an open-loop arrival schedule. The corrected tail is now honest and inside the SLO. Fixing only the generator would have revealed the stall without fixing it; fixing only the service would have left the next test blind to the next stall.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "Coordinated omission is a measurement bias in load tests. A closed-loop generator keeps a fixed number of requests in flight and creates the next request only after a response. When the service stalls for four seconds, the generator spends those four seconds waiting. It does not send the requests that would have arrived during the stall, so they never enter the latency histogram. The test reports a healthy p99 because the slow requests were never created.",
  },
  {
    type: "p",
    text: "An open-loop generator sends requests on a fixed schedule regardless of responses. During the same stall, the intended requests keep arriving, queue up, and record a wait of up to four seconds. A correction applied to closed-loop data does the same thing after the fact: each sample is measured from the time it should have been sent, not the time the generator got around to sending it. Tools that use HdrHistogram can store that corrected value in the latency histogram.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "p",
    text: "Coordinated omission sits in the measurement layer, not in the service. The service may be genuinely stalling; the test is what hides it. The same bias can appear in a metrics pipeline that samples only when a request completes, in a client that retries after a timeout, or in a dashboard that averages per-minute p99 values. Any measurement that pauses its own clock during a stall will underreport the stall.",
  },
  {
    type: "compare",
    leftTitle: "Closed loop",
    rightTitle: "Open loop",
    rows: [
      { label: "During a stall", left: "Stops sending; waits for the response", right: "Keeps sending at the intended rate" },
      { label: "Missing samples", left: "The requests that would have arrived", right: "None; they are created and measured" },
      { label: "Reported p99", left: "Can stay near the fast baseline", right: "Includes the stall wait" },
      { label: "Best use", left: "Throughput and concurrency limits", right: "User-facing latency and capacity tests" },
    ],
  },
  {
    type: "p",
    text: "This module models a load generator against a service with periodic stalls. The target rate, stall interval, and stall duration are controls. The reported p99 is what a closed-loop generator would record; the corrected p99 measures each sample from its intended arrival. The numbers are illustrative teaching values, not a benchmark of any load-testing tool.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "Reported p99 and corrected p99 side by side, with the gap between them.",
      "Achieved request rate versus the intended rate.",
      "The number of intended requests omitted per stall.",
      "The share of time the service spends stalled.",
      "A loop-mode control and a correction control, so you can separate the workload from the measurement.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Hidden stall: the reported p99 stays near 120ms while the corrected p99 reaches 4s. Then apply Open loop: the reported p99 now shows the stall, which proves the measurement was the problem. Use Recovery only after you can explain both changes.",
  },
  { type: "sim", simId: "coordinated-omission" },
  {
    type: "table",
    headers: ["Scenario", "Reported p99", "Corrected p99", "What the user would see"],
    rows: [
      ["Healthy, 100ms stall", "120ms", "120ms", "No visible stall"],
      ["Closed loop, 4s stall", "120ms", "4,000ms", "Four-second waits during each stall"],
      ["Open loop, 4s stall", "4,000ms", "4,000ms", "The same waits, now measured"],
      ["Recovery, 200ms stall", "120ms", "120ms", "Stall below the percentile's resolution"],
    ],
  },
  {
    type: "p",
    text: "The table is the whole lesson in four rows. The service did not change between the closed-loop and open-loop rows. The measurement did. A capacity decision based on the closed-loop row would certify a system that users experience as four seconds of waiting.",
  },
  { type: "experiment", experimentId: "predict-corrected" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset used a closed-loop generator at 1,000 rps with a four-second stall every thirty seconds. The generator spent 13.3% of the test waiting, so it achieved about 867 rps and omitted about 4,000 intended requests per stall. The reported p99 stayed at 120ms because the only samples it recorded were the fast requests sent after each stall. The corrected p99, measured from intended arrival, was 4,000ms.",
  },
  {
    type: "p",
    text: "Switching to an open-loop generator did not fix the service; it made the report honest. The reported p99 became 4,000ms as well. The recovery then reduced the stall to 200ms and kept the open loop, so the corrected tail fell inside the SLO. Measurement and mitigation are separate steps: one reveals the failure, the other removes it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load tests: a reported p99 that stays flat while the achieved rate falls is a bias signal, not a healthy service.",
      "wrk2 and HdrHistogram: intended-arrival timestamps and corrected latency output.",
      "Client metrics: request start time, response time, and timeout counters; compare with the server's own duration histogram.",
      "Traces: a gap in request starts during a stall, followed by a burst, is the closed-loop signature.",
      "Dashboards: p99 that drops when traffic drops can be a denominator problem, not an improvement.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the intended rate with the achieved rate. If the test lost throughput while p99 stayed flat, suspect coordinated omission. Then check whether the latency clock starts at actual send or intended arrival. Finally, compare the client-side tail with the server-side histogram; the gap is the measurement bias.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Report intended rate, achieved rate, and sample count next to every percentile.",
      "Run the load test open loop, or apply intended-arrival correction to every sample.",
      "Record the stall or timeout as a sample, not as a gap in the schedule.",
      "Compare client-side and server-side latency histograms; investigate the difference.",
      "Fix the service stall separately from the measurement bias.",
      "Re-run the test with the same stall pattern and verify the corrected tail moves with the service.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Open-loop tests can overwhelm a service and are harder to run safely than closed-loop tests.",
      "Correcting after the fact estimates the missing wait; it cannot recover samples the generator never created.",
      "A closed loop is still useful for throughput and concurrency limits, as long as its latency is not used as the user-facing number.",
      "Synthetic stalls are a model of real pauses, not a guarantee that production pauses have the same shape.",
      "Reporting both numbers adds context but also adds a number that can be misread; label which one is user-facing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-is-co",
    question:
      "What is coordinated omission, and why does it make a closed-loop p99 look better than the user experience?",
    difficulty: 2,
    hints: [
      "The generator waits for each response.",
      "During a stall it stops creating the requests that would have arrived.",
    ],
    answer:
      "Coordinated omission is the bias that occurs when a load generator's request schedule depends on responses. A closed-loop generator keeps a fixed number of requests in flight; during a stall it sends nothing new, so the requests that would have arrived during those seconds are never sampled. The histogram contains only the fast requests after the stall, and p99 stays low. Users, however, would have sent requests during the stall and waited. Measuring from intended arrival time or using an open-loop generator restores the missing wait.",
    followUps: [
      "How does the correction change the sample?",
      "Why is the achieved rate a clue?",
      "Does the same bias affect server-side metrics?",
    ],
    redFlags: [
      "Says the service is healthy because p99 is low.",
      "Blames the users.",
      "Confuses throughput with latency.",
    ],
    rubric: [
      "Explains the pause in request generation.",
      "Connects omitted samples to the tail.",
      "Names open loop or intended-arrival correction.",
      "Mentions the achieved-rate clue.",
    ],
  },
  {
    id: "prove-bias",
    question:
      "Your test reports p99 120ms, but users report four-second stalls. How do you prove the test is biased?",
    difficulty: 3,
    hints: [
      "Compare the intended rate with the achieved rate.",
      "Look for gaps in request starts during the stall.",
    ],
    answer:
      "I would first compare the intended request rate with the achieved rate over the test window. If the generator lost throughput during the stall, it was not sending at the intended rate. Then I would look at the request-start timeline: a gap followed by a burst is the closed-loop signature. I would also compare the client-side histogram with the server-side histogram and with the user-reported stall times. If the server saw requests during the gap that the client never sent, the bias is confirmed. Re-running open loop or with intended-arrival correction should reproduce the four-second tail.",
    followUps: [
      "What if the achieved rate is stable?",
      "How would a proxy or queue in front of the service affect the evidence?",
      "Which number would you show in the incident review?",
    ],
    redFlags: [
      "Trusts the reported p99 without checking the rate.",
      "Assumes the users are measuring differently.",
      "Re-runs the same closed-loop test.",
    ],
    rubric: [
      "Checks intended versus achieved rate.",
      "Looks for start-time gaps.",
      "Compares client and server histograms.",
      "Proposes an open-loop rerun.",
    ],
  },
  {
    id: "design-test",
    question:
      "How would you design a load test that does not hide a four-second stall?",
    difficulty: 3,
    hints: [
      "Keep the arrival schedule independent of responses.",
      "Record intended start time and report the sample count.",
    ],
    answer:
      "I would use an open-loop arrival schedule at the target rate, with enough concurrency to sustain it without the generator becoming the bottleneck. Each request would record its intended start time and its completion time, and the histogram would use the intended start for latency. I would report intended rate, achieved rate, sample count, and the corrected tail together, and I would inject a known stall to verify that the test can see it. I would also run the same test against the production dependency set and compare the client-side tail with the server-side histogram. The goal is to make the test fail when the service stalls, not to make the generator comfortable.",
    followUps: [
      "How do you avoid overwhelming the service with an open loop?",
      "What if the generator cannot sustain the target rate?",
      "How would you verify the correction itself?",
    ],
    redFlags: [
      "Uses a closed loop for latency.",
      "Reports only the average.",
      "Has no known-stall validation.",
    ],
    rubric: [
      "Uses an open-loop schedule.",
      "Records intended start time.",
      "Reports rate and sample count.",
      "Validates with a known stall.",
    ],
  },
  {
    id: "open-loop-limits",
    question:
      "Is an open-loop load test always better than a closed-loop test?",
    difficulty: 3,
    hints: [
      "Open loop measures demand; closed loop measures a feedback system.",
      "An open loop can overload the service and the generator.",
    ],
    answer:
      "No. Open loop is better for measuring user-facing latency under a fixed demand, because it keeps the arrival schedule independent of responses. Closed loop is better for modeling a system with natural backpressure, such as a fixed number of users or a queue with a concurrency limit. An open loop can overwhelm a service or the generator itself, and it can create a workload that no real client would produce. The right choice depends on the question: capacity and tail latency usually need open loop or correction; throughput and concurrency limits may need closed loop. In practice I would run both and label which number answers which question.",
    followUps: [
      "When would a closed loop be the realistic model?",
      "How do you protect the service during an open-loop test?",
      "What does a coordinated-omission-corrected closed loop still miss?",
    ],
    redFlags: [
      "Says open loop is always correct.",
      "Ignores generator saturation.",
      "Uses one test for every question.",
    ],
    rubric: [
      "Distinguishes demand from feedback.",
      "Names when each model fits.",
      "Mentions generator and service limits.",
      "Labels the number's purpose.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Load tests record intended start time and report both reported and corrected latency.",
      "Test results include intended rate, achieved rate, and sample count.",
      "The generator has a known-stall self-test that proves it can see a tail.",
      "Client-side and server-side latency histograms are compared after every load test.",
      "Capacity decisions cite the corrected tail, not the closed-loop p99.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare intended and achieved request rates before trusting a percentile.",
      "Look for gaps in request starts followed by bursts.",
      "Check whether the service stalled while the generator was waiting.",
      "Switch to an open-loop rerun or apply correction before making a capacity call.",
      "Separate the service stall from the measurement bias in the incident notes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run the test with the production stall pattern and an open loop.",
      "Verify that the corrected tail moves when the service changes.",
      "Document the sample count and the correction method.",
      "Add a known-stall validation to the load-test pipeline.",
    ],
  },
];

const references = [
  {
    title: "How NOT to Measure Latency",
    url: "https://www.infoq.com/presentations/latency-response-time/",
    publisher: "Gil Tene",
    kind: "talk" as const,
    note: "The coordinated omission problem and why percentile reports mislead.",
  },
  {
    title: "wrk2",
    url: "https://github.com/giltene/wrk2",
    publisher: "Gil Tene",
    kind: "docs" as const,
    note: "A constant-throughput HTTP benchmark with corrected latency.",
  },
  {
    title: "HdrHistogram",
    url: "https://github.com/HdrHistogram/HdrHistogram",
    publisher: "HdrHistogram",
    kind: "docs" as const,
    note: "High-dynamic-range histograms used for latency correction and percentile reporting.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "coordinated-omission": {
      model: coordinatedOmissionModel,
      presets,
      instructions:
        "Start healthy, then apply Hidden stall. Compare reported and corrected p99. Apply Open loop to see the same service measured honestly, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Stall timing and corrected latency are teaching values; the distinction between intended and actual arrival is the lesson.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-percentiles",
    "capacity-load-testing",
    "case-composite-load-test-bias",
    "foundations-use-red",
  ],
};
