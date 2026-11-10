import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_SERVICE_MS = 40;
const THINK_TIME_SEC = 0.1;
const WEIGHTED_CAPACITY = 10_000;
const READ_WEIGHT = 1;
const WRITE_WEIGHT = 2;

const params = [
  {
    id: "targetRps",
    label: "Intended arrival rate",
    min: 2_000,
    max: 30_000,
    step: 500,
    value: 5_000,
    unit: " rps",
    group: "Load",
    help: "Requests per second the test intends to offer, regardless of how fast the service responds.",
    format: "rps" as const,
  },
  {
    id: "virtualUsers",
    label: "Virtual users",
    min: 50,
    max: 3_000,
    step: 50,
    value: 1_000,
    unit: " users",
    group: "Load",
    help: "Closed-loop workers. Each one waits for a response plus think time before sending again. Ignored in open-loop mode.",
    format: "count" as const,
  },
  {
    id: "dependencyLatencyMs",
    label: "Dependency latency",
    min: 10,
    max: 300,
    step: 10,
    value: 60,
    unit: " ms",
    group: "Environment",
    help: "Time added by a downstream call on every request. It raises service time and lowers the capacity knee.",
    format: "ms" as const,
  },
  {
    id: "readSharePct",
    label: "Read share",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Mix",
    help: "Share of reads. A write is modeled at twice the capacity cost of a read, so a heavier write mix lowers sustainable rps.",
    format: "percent" as const,
  },
  {
    id: "loopMode",
    label: "Generator mode",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Load",
    help: "0 holds an open-loop arrival rate. 1 uses closed-loop virtual users that slow down when the service slows down.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isClosedLoop(p: Params): boolean {
  return num(p, "loopMode", 0) >= 0.5;
}

function capacityFor(p: Params): number {
  const readShare = clamp(num(p, "readSharePct", 80), 0, 100) / 100;
  const writeShare = 1 - readShare;
  return WEIGHTED_CAPACITY / Math.max(0.1, readShare * READ_WEIGHT + writeShare * WRITE_WEIGHT);
}

function serviceMsFor(p: Params): number {
  return BASE_SERVICE_MS + Math.max(0, num(p, "dependencyLatencyMs", 60));
}

function latencyFor(utilization: number, serviceMs: number): number {
  if (utilization <= 1) {
    return serviceMs * (1 + (3 * Math.pow(utilization, 6)) / Math.max(0.15, 1.05 - utilization));
  }
  return Math.min(15_000, serviceMs * 21 + (utilization - 1) * 6_000);
}

interface Computed {
  targetRps: number;
  achievedRps: number;
  capacity: number;
  utilization: number;
  reportedP99: number;
  correctedP99: number;
  fidelity: number;
  blindSpot: number;
  closedLoop: boolean;
}

function compute(p: Params): Computed {
  const targetRps = Math.max(1, num(p, "targetRps", 5_000));
  const users = Math.max(1, num(p, "virtualUsers", 1_000));
  const capacity = capacityFor(p);
  const serviceSec = serviceMsFor(p) / 1000;
  const closedLoop = isClosedLoop(p);
  const closedAchieved = Math.min(capacity, users / (serviceSec + THINK_TIME_SEC));
  const achievedRps = closedLoop ? closedAchieved : Math.min(targetRps, capacity);
  const utilization = closedLoop ? achievedRps / capacity : targetRps / capacity;
  const targetUtil = targetRps / capacity;
  const reportedP99 = latencyFor(Math.min(1.5, utilization), serviceMsFor(p));
  const correctedP99 = closedLoop && targetUtil > utilization
    ? latencyFor(Math.min(2, targetUtil), serviceMsFor(p))
    : reportedP99;
  const fidelity = closedLoop ? Math.min(100, (achievedRps / targetRps) * 100) : 100;
  return {
    targetRps,
    achievedRps,
    capacity,
    utilization,
    reportedP99,
    correctedP99,
    fidelity,
    blindSpot: Math.max(0, 100 - fidelity),
    closedLoop,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.utilization >= 0.9 || values.correctedP99 >= 800 || values.blindSpot >= 25) return "crit";
  if (values.utilization >= 0.7 || values.correctedP99 >= 300 || values.blindSpot >= 10) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const health = healthFor(values);
  const generatorHealth: "ok" | "warn" | "crit" =
    values.blindSpot >= 25 ? "crit" : values.blindSpot >= 10 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "generator",
        label: "Load generator",
        kind: "client",
        health: generatorHealth,
        utilization: clamp(values.achievedRps / Math.max(1, values.targetRps)),
        sublabel: `${Math.round(values.achievedRps).toLocaleString("en-US")} rps sent`,
        detail: `Intended ${Math.round(values.targetRps).toLocaleString("en-US")} rps; achieved ${Math.round(values.achievedRps).toLocaleString("en-US")} rps (${values.fidelity.toFixed(0)}% arrival fidelity). ${values.closedLoop ? "Closed loop." : "Open loop."}`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service under test",
        kind: "service",
        health,
        utilization: clamp(values.utilization),
        throughput: values.achievedRps,
        capacity: values.capacity,
        sublabel: `${Math.round(values.capacity).toLocaleString("en-US")} rps capacity`,
        detail: `Service time is ${serviceMsFor(p)}ms with the current dependency. Utilization is ${(values.utilization * 100).toFixed(0)}%; corrected p99 is ${values.correctedP99.toFixed(0)}ms.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Shared dependency",
        kind: "db",
        health: num(p, "dependencyLatencyMs", 60) >= 200 ? "warn" : "ok",
        utilization: clamp(num(p, "dependencyLatencyMs", 60) / 300),
        sublabel: `${num(p, "dependencyLatencyMs", 60)} ms`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("generator-service", "generator", "service", clamp(values.achievedRps / 30_000), generatorHealth),
      edge("service-dependency", "service", "dependency", clamp(values.achievedRps / 30_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("achieved-rps", "Achieved load", values.achievedRps, " rps", undefined, undefined, "rps"),
      metric("p99-reported", "Reported p99", values.reportedP99, "ms", undefined, undefined, "ms"),
      metric("p99-corrected", "Corrected p99", values.correctedP99, "ms", 300, 800, "ms"),
      metric("utilization", "Service utilization", values.utilization * 100, "%", 70, 90, "percent"),
      metric("arrival-fidelity", "Arrival fidelity", values.fidelity, "%", undefined, undefined, "percent"),
      metric("blind-spot", "Omitted load", values.blindSpot, "%", 10, 25, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      loopGapEvent: 0,
      slowDependencyEvent: 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `Intended ${Math.round(values.targetRps).toLocaleString("en-US")} rps, achieved ${Math.round(values.achievedRps).toLocaleString("en-US")} rps. Reported p99 ${values.reportedP99.toFixed(0)}ms, corrected p99 ${values.correctedP99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + (seed % 8)) / 2.6))),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed);
  seedSeries(frame, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99-corrected",
    metricId: "p99-corrected",
    warn: 300,
    crit: 800,
    title: "Corrected latency is past the SLO",
    cause:
      "The corrected percentile includes the requests the generator would have sent while it was waiting. A closed-loop report can look healthy while the service is already queueing; the omitted requests are the evidence.",
    fix:
      "Run the test open-loop at the intended arrival rate, or correct the histogram for the send interval. Report achieved arrival, not only the responses that completed.",
    checkFirst: [
      "Compare reported and corrected p99.",
      "Compare intended and achieved requests per second.",
      "Check whether the generator is open-loop or closed-loop.",
    ],
  },
  {
    id: "utilization",
    metricId: "utilization",
    warn: 70,
    crit: 90,
    title: "The service is at its queueing knee",
    cause:
      "Sustained utilization is close to the capacity limit. Queue length and tail latency rise nonlinearly here, so a small traffic increase produces a large latency increase.",
    fix:
      "Find the knee with an open-loop ramp and report the utilization at which p99 crosses the SLO. Add capacity or admission control before production reaches it.",
    checkFirst: [
      "Check whether the traffic mix matches production.",
      "Check dependency latency during the test.",
      "Check whether caches and connection pools are warm.",
    ],
  },
  {
    id: "blind-spot",
    metricId: "blind-spot",
    warn: 10,
    crit: 25,
    title: "The test never applied the intended load",
    cause:
      "Closed-loop users wait for each response, so a slow service receives fewer requests. The test can pass while measuring a fraction of the intended arrival rate. Coordinated omission hides the stalled requests from the latency percentile.",
    fix:
      "Hold the arrival rate independently of response time, and fail the test when arrival fidelity is below the agreed threshold. A test that did not send the load cannot certify the capacity.",
    checkFirst: [
      "Compare intended and achieved rps for the whole run.",
      "Check the generator's loop mode and think time.",
      "Check whether the test duration includes the ramp and the plateau.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const loadTestingModel: SimModel = {
  id: "capacity-load-testing",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    const values = compute(p);
    let loopGapEvent = frame.flags.loopGapEvent === 1;
    let slowDependencyEvent = frame.flags.slowDependencyEvent === 1;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (values.closedLoop && values.blindSpot >= 10 && !loopGapEvent) {
      pushEvent(next, {
        id: "closed-loop-gap",
        at: t,
        severity: values.blindSpot >= 25 ? "crit" : "warn",
        title: "Closed-loop generator is not applying the intended load",
        detail: `The test intends ${Math.round(values.targetRps).toLocaleString("en-US")} rps but sends ${Math.round(values.achievedRps).toLocaleString("en-US")} rps. ${values.blindSpot.toFixed(0)}% of the intended arrival never happened.`,
        nodeId: "generator",
        metricId: "blind-spot",
      });
      loopGapEvent = true;
    }
    if (!values.closedLoop || values.blindSpot < 10) loopGapEvent = false;

    if (num(p, "dependencyLatencyMs", 60) >= 200 && !slowDependencyEvent) {
      pushEvent(next, {
        id: "slow-dependency",
        at: t,
        severity: "warn",
        title: "Dependency latency is lowering the capacity knee",
        detail: `Each request spends ${num(p, "dependencyLatencyMs", 60)}ms in the dependency. The same fleet supports fewer requests per second before queueing dominates.`,
        nodeId: "dependency",
        metricId: "utilization",
      });
      slowDependencyEvent = true;
    }
    if (num(p, "dependencyLatencyMs", 60) < 200) slowDependencyEvent = false;

    next.flags.loopGapEvent = loopGapEvent ? 1 : 0;
    next.flags.slowDependencyEvent = slowDependencyEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `The test intended ${value("achieved-rps").toFixed(0)} rps of achieved load at ${value("utilization").toFixed(0)}% utilization. Reported p99 is ${value("p99-reported").toFixed(0)}ms; corrected p99 is ${value("p99-corrected").toFixed(0)}ms.`,
    ];
    if (value("blind-spot") >= 10) {
      items.push(
        `Arrival fidelity is ${value("arrival-fidelity").toFixed(0)}%. The generator eased off as the service slowed, so the test did not apply the intended arrivals.`,
      );
    }
    if (value("p99-corrected") >= 300) {
      items.push(
        "Corrected latency is above the SLO. The knee is here or lower; find it with an open-loop ramp before production does.",
      );
    }
    items.push(
      "Report the intended rate, the achieved rate, the mix, and the dependency latency with every result. A throughput number without those is not evidence.",
    );
    return items;
  },
  legend: [
    { label: "Valid test", tone: "ok" },
    { label: "Near the knee", tone: "warn" },
    { label: "Measurement invalid", tone: "crit" },
    { label: "Generator stopped", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Open-loop at 5,000 rps with an 80% read mix and 60ms dependency latency.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Near the knee",
    description: "Open-loop at 6,500 rps; utilization and p99 are above target but still inside the critical range.",
    tone: "warn",
    params: defaults({ targetRps: 6_500 }),
  },
  {
    id: "failure",
    label: "Closed-loop illusion",
    description: "A 10,000 rps target with 1,200 closed-loop users; the test reports 191ms p99 and never sends the load.",
    tone: "crit",
    params: defaults({ targetRps: 10_000, virtualUsers: 1_200, dependencyLatencyMs: 80, loopMode: 1 }),
  },
  {
    id: "recovery",
    label: "Open loop at the knee",
    description: "Open-loop at 4,500 rps; arrival fidelity is 100% and p99 is inside the SLO.",
    tone: "ok",
    params: defaults({ targetRps: 4_500 }),
  },
  {
    id: "dependency",
    label: "Slow dependency",
    description: "Open-loop at 7,000 rps with a 250ms dependency; the same fleet reaches the knee earlier.",
    tone: "crit",
    params: defaults({ targetRps: 7_000, dependencyLatencyMs: 250 }),
  },
];

const experiment: Experiment = {
  id: "predict-closed-loop-gap",
  title: "Predict why the passing test missed the production knee",
  simId: "load-testing",
  question:
    "A closed-loop test reports 191ms p99 at a 10,000 rps target and passes. Production fails near 6,000 rps. What is the most likely measurement problem?",
  prediction: {
    options: [
      { id: "duration", label: "The test did not run long enough" },
      { id: "arrival", label: "The closed-loop generator eased off, so the intended arrival was never applied" },
      { id: "tls", label: "TLS handshakes were not included" },
      { id: "disk", label: "Production has slower disks" },
    ],
    correctOptionId: "arrival",
    explanation:
      "Closed-loop users wait for a response before sending again. When the service slows, the generator sends less, so the test measures the responses it completed rather than the load it intended. Here the test intends 10,000 rps but sends about 5,450 rps, and the corrected p99 is over two seconds. The service never saw the 10,000 rps arrival, so the passing result cannot certify capacity at that rate.",
  },
  setup: defaults({ targetRps: 10_000, virtualUsers: 1_200, dependencyLatencyMs: 80, loopMode: 1 }),
  runFor: 30,
  observe: [
    "The generator achieves about 5,450 rps against a 10,000 rps target.",
    "Reported p99 is under 300ms, but the corrected p99 is above two seconds.",
    "The omitted-load metric is critical, so the test result is invalid even though the latency chart looks calm.",
  ],
  explain:
    "The reported percentile only includes requests that were sent. In a closed loop, the generator waits for each response, so a slow service receives fewer requests and the missing arrivals never enter the histogram. That is coordinated omission. The fix is to hold arrival independently of response time, use an open-loop generator or a corrected histogram, and report the achieved arrival rate next to the target. Traffic mix and dependency latency still matter: both lower the capacity knee.",
  fix: defaults({ targetRps: 6_500, virtualUsers: 1_200, dependencyLatencyMs: 80, readSharePct: 60, loopMode: 0 }),
  debrief:
    "The repaired test is open-loop and uses a production-like 60% read mix, which lowers sustainable capacity to about 7,100 rps. At a 6,500 rps target, utilization is above 90% and corrected p99 is critical. That is the correct result: a valid test should fail near the production knee. It is better to find that knee in a test than to let the first open-loop arrival be a customer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A load test is a capacity experiment. It applies a demand pattern to a service and measures whether the service meets its service-level objective (SLO) at that demand. The result is only as good as the demand model. Four properties decide whether the test predicts production: arrival mode, traffic mix, dependency behavior, and data realism. If any one is wrong, the test can certify a capacity the service does not have.",
  },
  {
    type: "p",
    text: "Arrival mode is the most common trap. An open-loop generator offers requests at a fixed rate even when the service is slow, so queueing and tail latency appear. A closed-loop generator uses a fixed number of virtual users; each user waits for a response plus think time before sending again. When the service slows, the closed loop sends less. The test may look stable because it never applied the intended load. Coordinated omission is the measurement version of the same problem: requests that were delayed before being sent never enter the latency histogram. The headline number is p99, the 99th-percentile response time, and it is only valid if the intended arrivals were actually offered.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is load generator, service under test, and its shared dependencies. The generator controls arrival. The service has a capacity knee set by CPU, memory, connection pools, and dependency latency. The dependency may be shared with production traffic or with other tests. Traffic mix changes the cost of each request: a write that touches a database costs more capacity than a cached read. The test environment must reproduce the mix, the data size, and the dependency latency that production sees.",
  },
  {
    type: "compare",
    leftTitle: "Closed loop",
    rightTitle: "Open loop",
    rows: [
      { label: "Control", left: "Fixed virtual users and think time", right: "Fixed arrival rate" },
      { label: "When the service slows", left: "Fewer requests are sent", right: "Arrivals continue and queue" },
      { label: "Tail latency", left: "Underreports stalls; coordinated omission", right: "Includes queueing delay" },
      { label: "Use it for", left: "Client concurrency limits and workflow simulation", right: "Capacity limits and SLO validation" },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Closed-loop illusion. Compare reported p99 with corrected p99 and intended with achieved rps. Then apply Slow dependency to see a real open-loop test fail. Run the experiment before changing sliders. Capacity weights, service times, and latency curves are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Intended and achieved requests per second, so a test that never applied its load is visible.",
      "Reported p99 beside corrected p99, with the gap caused by omitted arrivals.",
      "Service utilization and the capacity knee as traffic mix and dependency latency change.",
      "A flow view from generator to service to dependency, with the invalid measurement marked.",
    ],
  },
  { type: "sim", simId: "load-testing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The closed-loop test intended 10,000 rps with 1,200 users. Each user waited for a response plus think time, so the achieved rate settled near 5,450 rps. The reported p99 was under 300ms because the generator only measured the requests it managed to send. The corrected p99, which accounts for the arrivals that should have happened during the stalls, was above two seconds. The test passed while applying roughly half its intended load.",
  },
  {
    type: "p",
    text: "The slow-dependency preset shows the other direction. With an open-loop arrival and a 250ms dependency, the same fleet reaches the knee at a lower rate. The test is valid and fails, which is useful. A load test that cannot fail is usually not applying the load or not measuring the right arrival.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The generator reports a target rate but the service receives less; achieved rps is below intended for the whole plateau.",
      "p99 from the test is lower than production p99 at the same nominal rate.",
      "Production has a heavier write mix, larger payloads, colder caches, or slower dependencies than the test.",
      "The test dataset is small enough to fit in cache, so the test avoids the I/O that production performs.",
      "The test runs for minutes, while production queueing builds over a longer peak.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare intended and achieved rps. If they differ, the test result is not a capacity result. Then check the mix, dependency latency, data size, and test duration before trusting the knee.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Hold arrival independently of response time, and fail the test when achieved fidelity is below the threshold.",
      "Report the intended rate, achieved rate, duration, and traffic mix with every result.",
      "Use a production-like mix, including writes, payload sizes, and cache behavior.",
      "Model dependency latency and failure, not only the happy path.",
      "Ramp to the target and hold a plateau long enough for queues and caches to reach steady state.",
      "Correct the histogram for coordinated omission, or use a generator that already does.",
      "Repeat the test against the production-shaped environment before the event that needs the capacity number.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Open-loop tests are more truthful about capacity but can overwhelm a shared test environment and its dependencies.",
      "Closed-loop tests model real client concurrency but hide the queue when the service slows.",
      "A production-like dataset improves realism and raises test cost and setup time.",
      "A short ramp is cheaper but may miss the steady-state queue, cache, and connection behavior.",
      "Testing at the full target is the strongest evidence and carries the largest blast radius if the environment is shared.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-test-lied",
    question:
      "A load test passes at 10k rps and production fails at 6k. How do you find what was unrealistic?",
    difficulty: 3,
    hints: [
      "Start with what the test actually sent.",
      "Then compare mix, data, and dependencies.",
    ],
    answer:
      "I would first compare intended and achieved arrival for the whole test, because a closed-loop generator can pass without applying the target rate. Then I would compare the traffic mix, payload sizes, cache hit rate, dataset size, dependency latency, and test duration with production. I would also check whether the test corrected for coordinated omission. If the test sent 10k but production fails at 6k, the difference is either a lower capacity knee in production or a different demand shape; the same evidence distinguishes them.",
    followUps: [
      "How would you prove the generator eased off?",
      "Which production metric would you compare first?",
      "What would you change in the next test?",
    ],
    redFlags: [
      "Assumes the test result is correct.",
      "Compares only CPU.",
      "Ignores arrival fidelity.",
    ],
    rubric: [
      "Checks achieved versus intended load.",
      "Compares mix and dependencies.",
      "Mentions coordinated omission.",
      "Proposes a corrected test.",
    ],
  },
  {
    id: "coordinated-omission",
    question: "What is coordinated omission, and why does it make a test look better than production?",
    difficulty: 3,
    hints: [
      "The generator waits before sending the next request.",
      "The missing requests are the ones that would have been queued.",
    ],
    answer:
      "Coordinated omission happens when the load generator's send schedule depends on responses. If a response is slow, the generator waits and does not send the requests it would have sent during that wait. Those requests never enter the latency histogram, so the reported tail excludes the worst period. Production arrivals do not pause because the service is slow. The fix is to hold the arrival schedule independent of response time, correct the histogram, and report the achieved rate alongside the target.",
    followUps: [
      "How would you detect it from a test report?",
      "Does a closed-loop test ever make sense?",
      "How would you correct an existing histogram?",
    ],
    redFlags: [
      "Defines it as slow responses only.",
      "Thinks more virtual users solve it.",
      "Ignores the send schedule.",
    ],
    rubric: [
      "Explains the send schedule dependency.",
      "Names the missing arrivals.",
      "Proposes open-loop or correction.",
      "Connects it to the production tail.",
    ],
  },
  {
    id: "design-test",
    question: "How would you design a load test that finds the production knee?",
    difficulty: 3,
    hints: [
      "Start from production demand, not from a round number.",
      "A test needs an acceptance criterion.",
    ],
    answer:
      "I would start from production traffic: arrival rate, mix, payload sizes, cache behavior, dependency latency, and the peak duration. I would run an open-loop ramp with a plateau, measure p99 and errors against the SLO, and report the utilization at which the knee appears. I would use a production-like dataset and environment, warm the caches the way production does, and include dependency failures. The test should fail when arrival fidelity or the SLO gate fails. Finally I would repeat it before the event that depends on the capacity number.",
    followUps: [
      "How long should the plateau be?",
      "How do you avoid taking down a shared environment?",
      "What would you do if the test cannot reach production scale?",
    ],
    redFlags: [
      "Picks a round target with no demand model.",
      "Uses only a short spike.",
      "Has no pass/fail criterion.",
    ],
    rubric: [
      "Starts from production demand.",
      "Uses open-loop ramp and plateau.",
      "Defines SLO and arrival gates.",
      "Considers data, dependencies, and safety.",
    ],
  },
];

const checklist = [
  {
    title: "Before the test",
    items: [
      "The arrival mode is explicit and the generator can hold the target rate.",
      "Traffic mix, payload sizes, and data volume match production.",
      "Dependency latency and failure behavior are represented.",
      "The pass criterion includes p99, errors, and arrival fidelity.",
      "The environment and blast radius are agreed with the owners.",
    ],
  },
  {
    title: "During the test",
    items: [
      "Watch intended versus achieved rps for the whole run.",
      "Compare reported p99 with corrected p99.",
      "Record utilization at the knee and the first error.",
      "Stop the test if it affects production or another team's environment.",
    ],
  },
  {
    title: "After the test",
    items: [
      "Report the target, achieved arrival, mix, and dependency latency together.",
      "State whether the result is a capacity result or an invalid measurement.",
      "Record the knee and the headroom to the SLO.",
      "Re-run after a material change to the service or its dependencies.",
    ],
  },
];

const references = [
  {
    title: "Google SRE Book: Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google",
    kind: "book" as const,
    note: "Load, capacity, and the behavior of systems near saturation.",
  },
  {
    title: "wrk2: a constant-throughput HTTP benchmarking tool",
    url: "https://github.com/giltene/wrk2",
    publisher: "Gil Tene",
    kind: "docs" as const,
    note: "Corrects coordinated omission by holding arrival rate and recording latency from the intended send time.",
  },
  {
    title: "AWS Solutions: Distributed Load Testing",
    url: "https://docs.aws.amazon.com/solutions/latest/distributed-load-testing-on-aws/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "A managed load-generator pattern on AWS; useful for scale and isolation of test traffic.",
  },
  {
    title: "Amazon CloudWatch Synthetics canaries",
    url: "https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch_Synthetics_Canaries.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Synthetic traffic for availability and latency checks; not a substitute for an open-loop capacity test.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "load-testing": {
      model: loadTestingModel,
      presets,
      instructions:
        "Start Healthy, then apply Closed-loop illusion. Compare intended with achieved rps and reported with corrected p99. Then apply Slow dependency. Run the experiment before changing sliders.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Capacity weights, service times, and latency curves are teaching values, not benchmarks for a specific service.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-coordinated-omission",
    "capacity-capacity-models",
    "capacity-peak-events",
    "deployment-canary-capacity",
  ],
};
