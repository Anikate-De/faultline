import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY_RPS = 24_000;

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 9_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the checkout path. Traffic is demand, not health.",
    format: "rps",
  },
  {
    id: "affectedShare",
    label: "Traffic to failing route",
    min: 0,
    max: 100,
    step: 1,
    value: 8,
    unit: "%",
    group: "Failure",
    help: "Share of requests routed to the dependency path that is failing.",
    format: "percent",
  },
  {
    id: "dependencyErrorRate",
    label: "Dependency error rate",
    min: 0,
    max: 30,
    step: 0.1,
    value: 0.5,
    unit: "%",
    group: "Failure",
    help: "Share of calls to the failing dependency that return an error. The service fails those requests quickly.",
    format: "percent",
  },
  {
    id: "dependencyLatencyMs",
    label: "Dependency latency",
    min: 20,
    max: 800,
    step: 10,
    value: 120,
    unit: " ms",
    group: "Latency",
    help: "Latency added by the downstream call on successful requests. Failed calls return before this cost.",
    format: "ms",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  affectedShare: number;
  dependencyErrorRate: number;
  dependencyLatency: number;
  errorRate: number;
  successRps: number;
  failedRps: number;
  cpu: number;
  averageLatency: number;
  p99: number;
}

function compute(p: Params): Computed {
  const requestRate = num(p, "requestRate", 9_000);
  const affectedShare = num(p, "affectedShare", 8);
  const dependencyErrorRate = num(p, "dependencyErrorRate", 0.5);
  const dependencyLatency = num(p, "dependencyLatencyMs", 120);
  const errorRate = (affectedShare / 100) * (dependencyErrorRate / 100);
  const successRps = requestRate * (1 - errorRate);
  const failedRps = requestRate * errorRate;
  const cpu = clamp(
    16 + (successRps / CAPACITY_RPS) * 58 + (requestRate / CAPACITY_RPS) * 4,
    0,
    140,
  );
  const averageLatency = (1 - errorRate) * (28 + dependencyLatency * 0.8) + errorRate * 7;
  const p99 = 38 + dependencyLatency * 1.25;
  return {
    requestRate,
    affectedShare,
    dependencyErrorRate,
    dependencyLatency,
    errorRate,
    successRps,
    failedRps,
    cpu,
    averageLatency,
    p99,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function combine(...values: ("ok" | "warn" | "crit")[]): "ok" | "warn" | "crit" {
  if (values.includes("crit")) return "crit";
  if (values.includes("warn")) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.97 + 0.06 * Math.sin((index + (seed % 11)) / 2.6);
  const seeds: [string, number, number][] = [
    ["error-rate", values.errorRate * 100, 0.03],
    ["p99-latency", values.p99, 6],
    ["saturation", values.cpu, 2],
    ["traffic", values.requestRate, 180],
    ["avg-latency", values.averageLatency, 3],
    ["dependency-latency", values.dependencyLatency, 4],
    ["failed-rps", values.failedRps, 1],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const saturationHealth = healthFor(values.cpu, 70, 85);
  const errorHealth = healthFor(values.errorRate * 100, 1, 3);
  const dependencyHealth = healthFor(values.errorRate * 100, 1, 5);
  const latencyHealth = healthFor(values.p99, 300, 600);
  const checkoutHealth = combine(errorHealth, saturationHealth, latencyHealth);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "checkout",
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge gateway",
        kind: "lb",
        health: saturationHealth,
        utilization: clamp(values.cpu / 100),
        throughput: values.requestRate,
        sublabel: `${Math.round(values.requestRate).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: checkoutHealth,
        utilization: clamp(values.cpu / 100),
        throughput: values.successRps,
        sublabel: `${(values.errorRate * 100).toFixed(1)}% errors`,
        meta: { view: "flow" },
      },
      {
        id: "payments",
        label: "Payments dependency",
        kind: "external",
        health: dependencyHealth,
        sublabel: `${values.dependencyErrorRate.toFixed(1)}% calls failing`,
        meta: { view: "flow" },
      },
      {
        id: "database",
        label: "Orders database",
        kind: "db",
        health: "ok",
        utilization: clamp(values.successRps / 40_000),
        sublabel: "healthy headroom",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", 1),
      edge("edge-checkout", "edge", "checkout", 1, saturationHealth),
      edge("checkout-payments", "checkout", "payments", values.affectedShare / 100, errorHealth),
      edge("checkout-database", "checkout", "database", 0.15, "ok"),
    ],
    metrics: [
      metric("error-rate", "Error rate", values.errorRate * 100, "%", 1, 3, "percent"),
      metric("p99-latency", "Latency p99", values.p99, " ms", 300, 600, "ms"),
      metric("saturation", "Saturation (CPU)", values.cpu, "%", 70, 85, "percent"),
      metric("traffic", "Traffic", values.requestRate, " rps", undefined, undefined, "rps"),
      metric(
        "avg-latency",
        "Average latency",
        values.averageLatency,
        " ms",
        undefined,
        undefined,
        "ms",
      ),
      metric(
        "dependency-latency",
        "Dependency latency",
        values.dependencyLatency,
        " ms",
        undefined,
        undefined,
        "ms",
      ),
      metric(
        "failed-rps",
        "Failed requests",
        values.failedRps,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      latencyHealth,
    },
    summary: `${Math.round(values.requestRate).toLocaleString()} rps, ${(values.errorRate * 100).toFixed(1)}% errors, p99 ${values.p99.toFixed(0)}ms, CPU ${values.cpu.toFixed(0)}%.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 3,
    title: "Request errors crossed the critical threshold",
    cause:
      "A dependency rejects a slice of traffic, but the service returns those failures quickly. CPU stays low and the blended latency can stay flat because failed requests finish early.",
    fix: "Graph errors by route, status, and dependency before touching capacity. Then shed, retry with a budget, or roll back the failing dependency.",
    checkFirst: [
      "Split 5xx rate by route, status code, and downstream dependency.",
      "Compare failed-request latency with successful-request latency.",
      "Check whether the dashboard hides the failing route behind an aggregate.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 600,
    title: "Request latency p99 breached the threshold",
    cause:
      "A downstream call or a queue is adding delay to successful requests. Blended averages can hide this when fast failures dilute the sample.",
    fix: "Separate successful and failed latency, then trace the slow hop. Latency is a symptom; saturation, contention, or a slow dependency is the cause.",
    checkFirst: [
      "Compare success-path latency with error-path latency.",
      "Check dependency latency and connection-pool wait.",
      "Check whether traffic or retries changed at the same time.",
    ],
  },
  {
    id: "saturation",
    metricId: "saturation",
    warn: 70,
    crit: 85,
    title: "Service CPU is saturated",
    cause:
      "The service is approaching its usable CPU limit. Saturation raises queueing and tail latency before the average CPU looks dramatic.",
    fix: "Reduce work, add capacity, or shed low-value traffic. Confirm that CPU is the constrained resource before scaling.",
    checkFirst: [
      "Check per-instance CPU and run-queue depth, not the fleet average.",
      "Check whether a dependency change increased CPU per request.",
      "Check whether traffic is within the tested capacity envelope.",
    ],
  },
];

export const goldenSignalsModel: SimModel = {
  id: "observability-golden-signals",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const jitter = rng.between(-0.4, 0.4);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "dependency-latency"
        ? { ...item, value: Math.max(0, item.value + jitter) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.errorRate >= 0.01 && frame.flags.errorSpike !== 1) {
      pushEvent(next, {
        id: "error-spike",
        severity: "warn",
        title: "Errors rising without CPU pressure",
        detail: `The failing route returns ${(values.errorRate * 100).toFixed(1)}% errors while CPU is ${values.cpu.toFixed(0)}% and p99 is ${values.p99.toFixed(0)}ms. The error signal is the only one that crossed a threshold.`,
        nodeId: "checkout",
        metricId: "error-rate",
      });
      next.flags.errorSpike = 1;
    }
    if (values.errorRate < 0.01) next.flags.errorSpike = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Errors are ${(values.errorRate * 100).toFixed(2)}% of traffic, about ${Math.round(values.failedRps).toLocaleString()} failed requests per second.`,
    );
    if (values.errorRate >= 0.01) {
      items.push(
        "The failed requests return faster than successful ones, so the blended average and p99 can look healthy. Split the error signal by route and dependency.",
      );
    } else {
      items.push("Error rate is below the warning threshold in this parameter set.");
    }
    items.push(
      `Saturation is ${values.cpu.toFixed(0)}% of the teaching CPU budget; p99 is ${values.p99.toFixed(0)}ms and average latency is ${values.averageLatency.toFixed(0)}ms.`,
    );
    if (values.cpu >= 70) {
      items.push(
        "CPU is above the warning threshold. Saturation is a leading indicator, even when errors are still low.",
      );
    }
    const hidden = frame.flags.latencyHealth;
    if (hidden === "crit")
      items.push("A latency threshold is also active; do not explain it with CPU alone.");
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
    description: "Low error rate, comfortable CPU, and normal dependency latency.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "High traffic pushes CPU near its warning range while errors stay low.",
    tone: "warn",
    params: defaults({
      requestRate: 24_000,
      affectedShare: 20,
      dependencyErrorRate: 1.2,
      dependencyLatencyMs: 120,
    }),
  },
  {
    id: "failure",
    label: "Hidden errors",
    description: "A failing route returns 5.6% errors while CPU and p99 stay normal.",
    tone: "crit",
    params: defaults({
      requestRate: 9_000,
      affectedShare: 70,
      dependencyErrorRate: 8,
      dependencyLatencyMs: 120,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The failing route is removed from rotation and traffic settles.",
    tone: "ok",
    params: defaults({
      requestRate: 12_000,
      affectedShare: 10,
      dependencyErrorRate: 0.2,
      dependencyLatencyMs: 120,
    }),
  },
];

const experiment: Experiment = {
  id: "find-the-missing-signal",
  title: "Find the signal the dashboard omitted",
  simId: "golden-signals",
  question:
    "Users report failed checkouts. CPU is 38%, p99 is 188ms, and traffic is flat at 9,000 rps. Which golden signal exposes the incident?",
  prediction: {
    options: [
      { id: "errors", label: "Errors: the failed-request rate" },
      { id: "latency", label: "Latency: the p99 of the blended request mix" },
      { id: "traffic", label: "Traffic: the request rate" },
      { id: "saturation", label: "Saturation: the CPU percentage" },
    ],
    correctOptionId: "errors",
    explanation:
      "The failing dependency returns errors quickly. CPU never rises and the blended p99 stays near the successful path. Only the error rate, split by route or dependency, shows the failure.",
  },
  setup: presets[2].params,
  runFor: 20,
  observe: [
    "Error rate rises to 5.6% and crosses the critical threshold.",
    "CPU stays near 38% and p99 stays near 188ms.",
    "Average latency falls slightly because failed requests return faster.",
    "The checkout and payments nodes turn critical while the database stays healthy.",
  ],
  explain:
    "The four golden signals are not interchangeable. Latency describes how long requests take, traffic describes demand, errors describe failed requests, and saturation describes how full the constrained resource is. A fast failure can keep latency and CPU normal, so error rate must be graphed separately and split by route.",
  fix: { affectedShare: 0 },
  debrief:
    "Removing the failing route from rotation brings errors below the warning threshold while keeping CPU and latency stable. The remaining work is to add an error-rate panel by route and dependency, and to keep failed-request latency separate from successful-request latency.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The four golden signals are latency, traffic, errors, and saturation. Latency is the time a request takes. Traffic is demand on the system, usually requests per second. Errors are requests that fail explicitly, implicitly, or by policy. Saturation is how full the most constrained resource is, whether that resource is CPU, memory, a connection pool, or a queue.",
  },
  {
    type: "p",
    text: "They answer different questions. Latency asks how slow the user experience is. Traffic asks how much work arrived. Errors ask how much of that work failed. Saturation asks how much room is left before the system degrades. A dashboard that graphs only one or two of them can look calm while the missing signal is already in trouble.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "For a service, the request path is client, edge, service, and dependencies. RED (rate, errors, duration) is a service lens. USE (utilization, saturation, errors) is a resource lens. The golden signals sit above both. They are the small set of user-facing measurements that tell you whether the service is healthy before you know which resource or dependency caused the problem.",
  },
  {
    type: "compare",
    leftTitle: "RED for services",
    rightTitle: "USE for resources",
    rows: [
      {
        label: "Primary question",
        left: "Is the request path healthy?",
        right: "Is the resource running out?",
      },
      {
        label: "Signals",
        left: "Rate, errors, duration",
        right: "Utilization, saturation, errors",
      },
      {
        label: "Best first move",
        left: "Graph errors and latency by route",
        right: "Graph per-instance utilization and queue depth",
      },
      {
        label: "Blind spot",
        left: "A saturated dependency can still look healthy at the edge",
        right: "A healthy resource can still serve failing requests",
      },
    ],
  },
  {
    type: "p",
    text: "This module models a checkout path with four sliders. Traffic, error injection, and dependency latency are illustrative teaching values. They are not a capacity guarantee for any provider. The shape of the failure is the lesson: failed requests can be fast, so latency and CPU can remain normal while the error signal rises.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Hidden errors. Watch the error-rate panel and the checkout node, not CPU. Run the guided experiment before reading the debrief, then apply Recovery and compare all four signals.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Error rate: the share of requests that fail, with a warning at 1% and critical at 3%.",
      "Latency p99: the tail of the blended request mix (the 99th percentile), not a separate success-path view.",
      "Saturation: CPU as a percentage of the teaching capacity.",
      "Traffic: request rate, so you can tell a demand change from a health change.",
      "Average latency and dependency latency: the inputs that explain why p99 moved or did not.",
    ],
  },
  {
    type: "p",
    text: "A green CPU graph is not a health statement. CPU can be low because requests fail before they consume work. A blended p99 can be low because failures return in a few milliseconds. When users complain and the dashboard is green, check which signal is missing, then split the existing signals by route, status, and dependency.",
  },
  { type: "sim", simId: "golden-signals" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failing dependency rejected a large share of calls on one route. The service returned those failures quickly, so they consumed little CPU and did not lengthen the blended latency. Traffic stayed flat. The error-rate panel was the only signal that crossed a threshold, and the checkout and payments nodes turned critical while the database stayed healthy.",
  },
  {
    type: "p",
    text: "The blended average latency actually fell because failed requests returned faster than successful ones. That is a useful clue, not a comfort. It means the sample is mixing two different populations. Successful-request latency and failed-request latency must be separated before the average or p99 can be trusted.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      'Prometheus: `http_requests_total{status=~"5.."}` divided by `http_requests_total`, split by route and dependency.',
      "Grafana: one panel for error ratio, one for success-path p99, one for traffic, and one for the constrained resource.",
      "Datadog: request errors, request duration, and saturation from APM or Universal Service Monitoring, with tags for route and downstream service.",
      "Logs: a burst of dependency timeout or rejection messages that does not appear in CPU or latency dashboards.",
      "Traces: a short failing span on the dependency path while the successful span remains fast.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split the error rate by route and dependency. Compare failed-request latency with successful-request latency. Confirm that traffic did not change at the same time. Only then decide whether the incident is a capacity problem, a dependency problem, or a measurement gap.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add the missing signal: error rate by route, status, and dependency.",
      "Separate successful and failed latency so fast failures cannot dilute the tail.",
      "Remove or roll back the failing dependency path if it is not serving useful work.",
      "Add a bounded fallback or retry budget so failures do not amplify.",
      "Recheck all four signals at peak, not only the one that paged.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More labels and routes improve diagnosis but increase cardinality and query cost.",
      "Separate success and error panels add clarity but take more dashboard space and attention.",
      "Alerting on every golden signal creates noise; page on user-visible symptoms and use the others for diagnosis.",
      "A fast failure can protect latency while hiding a correctness problem, so error rate and correctness checks are complementary.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "missing-signal",
    question:
      "CPU is normal, latency is normal, and users report failures. Which golden signal do you check first, and how do you confirm it?",
    difficulty: 2,
    hints: [
      "A failed request can return faster than a successful one.",
      "Aggregate latency mixes successful and failed requests.",
    ],
    answer:
      "I check errors first, split by route, status code, and downstream dependency. I compare the failed-request rate with the successful-request rate and then compare failed-request latency with successful-request latency. If failures are fast, CPU and blended latency can both look normal. I confirm with a trace or a dependency error metric, and I check whether the aggregate panel is hiding one bad route.",
    followUps: [
      "What if errors are also normal but users still complain?",
      "Which signal would you add to the first dashboard row?",
      "How does a retry change the error signal?",
    ],
    redFlags: [
      "Scales CPU without checking errors.",
      "Trusts the blended average latency.",
      "Assumes users are wrong because the dashboard is green.",
    ],
    rubric: [
      "Names errors as the missing signal.",
      "Splits by route or dependency.",
      "Separates success and error latency.",
      "Names a confirmation step.",
    ],
  },
  {
    id: "latency-vs-saturation",
    question:
      "Latency p99 is rising and CPU is at 65%. Is this saturation, a dependency problem, or a measurement problem?",
    difficulty: 2,
    hints: [
      "CPU is not the only constrained resource.",
      "Look at the dependency span and the queue before the CPU graph.",
    ],
    answer:
      "I would not call it saturation from CPU alone. I would split p99 by route and instance, check dependency latency, connection-pool wait, queue depth, and run-queue length, and compare the onset of the latency rise with traffic and deploy changes. CPU at 65% can still be near a queueing knee if the service is bursty or if another resource is the real constraint. I would use traces to find the slow hop and then confirm the resource signal at that hop.",
    followUps: [
      "What would make you suspect a noisy neighbor?",
      "Which USE signal would you graph next?",
      "How would a retry storm change the picture?",
    ],
    redFlags: [
      "Calls it saturation because CPU is above 50%.",
      "Ignores dependency latency.",
      "Does not split by instance or route.",
    ],
    rubric: [
      "Rejects a single-cause conclusion.",
      "Checks other constrained resources.",
      "Uses traces or per-route data.",
      "Names a falsifying check.",
    ],
  },
  {
    id: "dashboard-coverage",
    question:
      "You can add only four panels to a first-response service dashboard. What do you choose and what do you leave out?",
    difficulty: 2,
    hints: [
      "Start from the four golden signals.",
      "A panel should support a decision, not satisfy curiosity.",
    ],
    answer:
      "I choose error ratio, success-path latency at p99, traffic, and saturation of the most constrained resource. I split each by the dimensions on-call uses first: route, status, and dependency. I leave out per-host CPU mosaics, business metrics, and long historical trends until the first four answer whether the service is failing and where to look next. I add links to traces, logs, and the runbook rather than more panels.",
    followUps: [
      "Where does the dependency latency panel go?",
      "How do you keep the dashboard useful at 3 a.m.?",
      "What would you add for a batch service?",
    ],
    redFlags: [
      "Lists dozens of metrics.",
      "Omits errors or saturation.",
      "Adds panels without a decision.",
    ],
    rubric: [
      "Covers all four signals.",
      "Orders by diagnostic value.",
      "States what is intentionally omitted.",
      "Links to the next check.",
    ],
  },
  {
    id: "fast-failure",
    question:
      "Why can a service show a falling average latency during an incident, and why is that dangerous?",
    difficulty: 3,
    hints: ["Think about which requests finish quickly.", "An average is a mixture."],
    answer:
      "Failed requests often return immediately because the failure happens before the expensive work. If the error share grows, the fast failures pull the average down even though successful requests are unchanged or slower. The average is then a mixture of two populations with different causes. It is dangerous because it can make the service look healthier during a failure. The fix is to separate success and error latency and to graph the error rate explicitly.",
    followUps: [
      "How would you compute a success-only p99?",
      "What does a slow error tell you?",
      "Which service-level objective (SLO) would catch this?",
    ],
    redFlags: [
      "Says the average is always useless.",
      "Does not separate populations.",
      "Ignores the error rate.",
    ],
    rubric: [
      "Explains the mixture effect.",
      "Names fast failures.",
      "Proposes success-only latency.",
      "Connects to user impact.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The first dashboard row covers latency, traffic, errors, and saturation.",
      "Errors are split by route, status, and downstream dependency.",
      "Success-path latency is separate from failed-request latency.",
      "The constrained resource is named for each service, not assumed to be CPU.",
      "Every panel links to a trace, log query, or runbook.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify which signal moved first and which signal is missing.",
      "Split aggregates before trusting them.",
      "Check whether fast failures are diluting latency.",
      "Confirm the constrained resource at the slow hop.",
      "Record the timeline and the decision for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the missing signal and remove panels that did not support a decision.",
      "Verify the dashboard at peak traffic and during a dependency failure.",
      "Check that error and latency alerts do not duplicate each other.",
      "Document the tradeoff between coverage and dashboard noise.",
    ],
  },
];

const references = [
  {
    title: "Monitoring Distributed Systems",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "The four golden signals and the distinction between symptoms and causes.",
  },
  {
    title: "Monitoring 101: Alerting on what matters",
    url: "https://www.datadoghq.com/blog/monitoring-101-alerting/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Practical alerting on symptoms, with service-level signals.",
  },
  {
    title: "Grafana dashboard best practices",
    url: "https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "RED, USE, and the four golden signals in dashboard design.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "golden-signals": {
      model: goldenSignalsModel,
      presets,
      instructions:
        "Start healthy, apply Hidden errors, and compare all four signals. The error rate is the incident; CPU and p99 are not.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Traffic, latency, and capacity values are teaching figures, not provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-use-red",
    "foundations-percentiles",
    "observability-metrics-types",
    "observability-grafana-dashboard",
  ],
};
