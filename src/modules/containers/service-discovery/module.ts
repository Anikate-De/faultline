import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TASK_COUNT = 8;
const SMOOTHING_SECONDS = 3;

const params: ParamSpec[] = [
  {
    id: "dnsTtlSeconds",
    label: "DNS record TTL",
    min: 5,
    max: 120,
    step: 5,
    value: 10,
    unit: " s",
    group: "DNS",
    help: "How long a resolver may cache the answer. A shorter TTL reacts faster to replacements and raises query volume.",
    format: "number",
  },
  {
    id: "taskLifetimeSeconds",
    label: "Average task lifetime",
    min: 30,
    max: 600,
    step: 10,
    value: 300,
    unit: " s",
    group: "Churn",
    help: "Average time before a task is replaced by a deployment, a scale event, or a failure. Shorter lifetimes make stale records more likely.",
    format: "number",
  },
  {
    id: "healthDetectionSeconds",
    label: "Observed health-detection time",
    min: 0,
    max: 60,
    step: 5,
    value: 5,
    unit: " s",
    group: "Health",
    help: "Observed time from a task failing to its registration being marked unhealthy. Detection affects new answers; it does not shorten an answer already cached by a resolver.",
    format: "number",
  },
  {
    id: "healthCoverage",
    label: "Registered instances with health checks",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Health",
    help: "Share of registered tasks whose health is actually checked. An unchecked dead task stays discoverable.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Target {
  ttl: number;
  lifetime: number;
  detection: number;
  coverage: number;
  unchecked: number;
  staleWindow: number;
  staleShare: number;
  lookupErrors: number;
  resolutionMs: number;
  uncheckedTasks: number;
}

function target(p: Params): Target {
  const ttl = clamp(num(p, "dnsTtlSeconds", 10), 5, 120);
  const lifetime = clamp(num(p, "taskLifetimeSeconds", 300), 30, 600);
  const detection = clamp(num(p, "healthDetectionSeconds", 5), 0, 60);
  const coverage = clamp(num(p, "healthCoverage", 100), 0, 100);
  const unchecked = (100 - coverage) / 100;
  const staleWindow = ttl;
  const staleShare = clamp((ttl / lifetime) * 100 + (detection / lifetime) * 15 + unchecked * 40, 0, 100);
  return {
    ttl,
    lifetime,
    detection,
    coverage,
    unchecked,
    staleWindow,
    staleShare,
    lookupErrors: clamp(staleShare * 0.22 + unchecked * 4, 0, 100),
    resolutionMs: 8 + ttl * 0.35 + staleShare * 0.15,
    uncheckedTasks: Math.round(TASK_COUNT * unchecked),
  };
}

function healthOf(staleShare: number, errors: number): Health {
  if (staleShare >= 20 || errors >= 5) return "crit";
  if (staleShare >= 5 || errors >= 1) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Target, exposure: number): SimFrame {
  const stale = clamp(exposure, 0, 100);
  const errors = clamp(stale * 0.22 + values.unchecked * 4, 0, 100);
  const health = healthOf(stale, errors);
  const coverageHealth: Health =
    values.coverage >= 100 ? "ok" : values.coverage >= 80 ? "warn" : "crit";
  const resolverHealth: Health = values.ttl >= 90 ? "warn" : "ok";
  const deadHealth: Health = stale >= 20 ? "crit" : stale >= 5 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "orders-service",
      kind: "service",
      health,
      sublabel: `${stale.toFixed(1)}% stale lookups`,
      detail: `The caller uses checkout.internal instead of an IP. ${stale.toFixed(1)}% of its resolutions in this model reach a task that has already been replaced.`,
      meta: { stale: Number(stale.toFixed(1)), errors: Number(errors.toFixed(1)) },
    },
    {
      id: "resolver",
      label: "Resolver cache",
      kind: "dns",
      health: resolverHealth,
      utilization: clamp(values.ttl / 120),
      sublabel: `TTL ${values.ttl.toFixed(0)}s`,
      detail: `A resolver may reuse an answer for up to ${values.ttl.toFixed(0)} seconds. Cached answers are not rewritten when the registry removes a task.`,
      meta: { ttl: values.ttl },
    },
    {
      id: "registry",
      label: "Cloud Map registry",
      kind: "dns",
      health: coverageHealth,
      sublabel: `${TASK_COUNT - values.uncheckedTasks} of ${TASK_COUNT} health-checked`,
      detail: `The registry holds the current task IPs. ${values.coverage.toFixed(0)}% of tasks have health checks; unchecked tasks are never removed for being unhealthy.`,
      meta: { coverage: values.coverage, tasks: TASK_COUNT },
    },
    {
      id: "live-tasks",
      label: "Registered tasks",
      kind: "worker",
      health: coverageHealth,
      utilization: clamp((TASK_COUNT - values.uncheckedTasks) / TASK_COUNT),
      sublabel: `${Math.max(0, TASK_COUNT - values.uncheckedTasks)} health-checked`,
      detail:
        values.uncheckedTasks > 0
          ? `${values.uncheckedTasks} task(s) are registered without a health check. They may be healthy, but a failure stays discoverable until the task is deregistered.`
          : "Every registered task has a health check. A failing task is marked unhealthy after the detection time and removed from new answers.",
      meta: { healthChecked: TASK_COUNT - values.uncheckedTasks },
    },
    {
      id: "stale-addresses",
      label: "Stale cached addresses",
      kind: "worker",
      health: deadHealth,
      utilization: clamp(stale / 100),
      sublabel: `${stale.toFixed(0)}% of lookups`,
      detail: `These answers point at tasks that are gone. They persist until the resolver's TTL expires, even when the registry has already removed the task.`,
      meta: { stale: Number(stale.toFixed(1)) },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-resolver", "client", "resolver", 1, health, "resolve"),
      edge("resolver-registry", "resolver", "registry", clamp(1 - stale / 100), coverageHealth, "on cache miss"),
      edge("registry-tasks", "registry", "live-tasks", clamp((TASK_COUNT - values.uncheckedTasks) / TASK_COUNT), coverageHealth, "returns IPs"),
      edge("resolver-stale", "resolver", "stale-addresses", clamp(stale / 100), deadHealth, "cached answer"),
    ],
    metrics: [
      metric("stale-lookups", "Lookups routed to a dead task", stale, "%", 5, 20, "percent"),
      metric("lookup-errors", "Request errors from stale answers", errors, "%", 1, 5, "percent"),
      metric("stale-window", "Maximum cached staleness (TTL)", values.staleWindow, " s", 15, 45, "number"),
      metric("resolution-time", "Resolution time", values.resolutionMs, " ms", 40, 80, "ms"),
      metric("dns-ttl", "DNS record TTL", values.ttl, " s", undefined, undefined, "number"),
      metric("registered-tasks", "Registered tasks", TASK_COUNT, "", undefined, undefined, "count"),
      metric("unchecked-tasks", "Tasks without health checks", values.uncheckedTasks, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, target: values.staleShare, exposure: stale },
    summary: `TTL ${values.ttl.toFixed(0)}s, tasks replaced every ${values.lifetime.toFixed(0)}s, ${stale.toFixed(0)}% of lookups stale, ${errors.toFixed(1)}% errors.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.4) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-lookups",
    metricId: "stale-lookups",
    warn: 5,
    crit: 20,
    title: "Resolvers are sending traffic to replaced tasks",
    cause:
      "A cached DNS answer outlives the task it names. The registry can remove a dead task quickly, but resolvers and client libraries keep the old address until their own cache expires. Short task lifetimes make this more likely.",
    fix:
      "Lower the record TTL and make health checks cover every registered task. Then check the client side: a connection pool or library cache can keep using an address longer than the DNS TTL suggests.",
    checkFirst: [
      "Compare the DNS TTL with the average task lifetime and the client's own cache settings.",
      "Check whether every registered task has a health check.",
      "Look for connection reuse or keep-alive that survives a DNS answer change.",
    ],
  },
  {
    id: "lookup-errors",
    metricId: "lookup-errors",
    warn: 1,
    crit: 5,
    title: "Callers are failing on addresses that no longer exist",
    cause:
      "Stale answers and unchecked dead tasks both produce requests to endpoints that cannot serve. Retries may amplify the errors if every caller refreshes the same bad record.",
    fix:
      "Fix registration health first: remove dead instances and health-check the rest. Then shorten the TTL for names that must follow churn. Verify the fix from a caller, not only from the registry.",
    checkFirst: [
      "Check the error type: connection refused, timeout, or 5xx from an old task.",
      "Confirm the registry no longer lists the dead IP.",
      "Check whether the caller still holds a cached answer or an open connection.",
    ],
  },
  {
    id: "stale-window",
    metricId: "stale-window",
    warn: 15,
    crit: 45,
    title: "The cache window is longer than the service can tolerate",
    cause:
      "The TTL is the window in which a compliant resolver can still return a task that is already gone. A long TTL is efficient for stable services and dangerous for services with short task lifetimes.",
    fix:
      "Set the TTL from the replacement rate and the error budget, not from habit. If the TTL must stay high for query volume, make the caller tolerate connection failure and remove tasks from the registry as soon as health detection confirms the failure.",
    checkFirst: [
      "Measure how often tasks are replaced during normal operation.",
      "Check whether traffic fails during a normal deployment, not only during an incident.",
      "Compare query volume at the current TTL with the resolver capacity.",
    ],
  },
];

export const serviceDiscoveryModel: SimModel = {
  id: "containers-service-discovery",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = target(p);
    const frame = buildFrame(seed, values, 0);
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p, dt) => {
    const values = target(p);
    const previous = Number(frame.flags.exposure ?? 0);
    const alpha = 1 - Math.exp(-Math.max(0, dt) / SMOOTHING_SECONDS);
    const exposure = previous + (values.staleShare - previous) * alpha;
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values, exposure);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, paramsKey: JSON.stringify(p) };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = target(p);
    return [
      `The name checkout.internal has a ${values.ttl.toFixed(0)}-second TTL while tasks live about ${values.lifetime.toFixed(0)} seconds.`,
      values.staleShare >= 10
        ? `At this churn and TTL, most cached answers can point at a replaced task before they expire. The model shows ${values.staleShare.toFixed(0)}% stale lookups at steady state.`
        : `Cached answers usually expire before the task changes. The model shows ${values.staleShare.toFixed(1)}% stale lookups at steady state.`,
      values.uncheckedTasks > 0
        ? `${values.uncheckedTasks} registered task(s) have no health check, so a dead task can remain discoverable even with a short TTL.`
        : "Every registered task has a health check, so health detection can remove a dead task from new answers.",
      "Removing a task from the registry does not erase answers already cached by resolvers, client libraries, or connection pools.",
      "A stable name removes hard-coded IPs. It does not remove the need to handle a connection to a task that has just stopped.",
    ];
  },
  legend: [
    { label: "Fresh answers", tone: "ok" },
    { label: "Some stale answers", tone: "warn" },
    { label: "Dead endpoints in rotation", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 10-second TTL, 300-second task lifetime, and health checks on every task.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Frequent deploys",
    description: "A 20-second TTL with tasks replaced every two minutes. Some answers outlive their task.",
    tone: "warn",
    elapsed: 20,
    params: defaults({ dnsTtlSeconds: 20, taskLifetimeSeconds: 120, healthDetectionSeconds: 10, healthCoverage: 100 }),
  },
  {
    id: "failure",
    label: "Stale rotation",
    description: "A 120-second TTL, 60-second task lifetime, and 70% health coverage leave dead IPs in rotation.",
    tone: "crit",
    elapsed: 30,
    params: defaults({ dnsTtlSeconds: 120, taskLifetimeSeconds: 60, healthDetectionSeconds: 30, healthCoverage: 70 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Short TTL, long task lifetime, fast health detection, and health checks on every task.",
    tone: "ok",
    elapsed: 10,
    params: defaults({ dnsTtlSeconds: 10, taskLifetimeSeconds: 300, healthDetectionSeconds: 5, healthCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-window",
  title: "Predict how long a dead IP stays reachable",
  simId: "service-discovery",
  question:
    "A task is replaced. The DNS record has a 120-second TTL and the caller cached the answer just before the replacement. How long can that caller keep sending traffic to the dead IP?",
  prediction: {
    options: [
      { id: "detection", label: "About 5 seconds, because health detection marks the task unhealthy" },
      { id: "ttl", label: "Up to 120 seconds, because the cached answer keeps its TTL" },
      { id: "instant", label: "Immediately, because DNS answers are pushed to every client" },
      { id: "forever", label: "Forever, until the caller restarts" },
    ],
    correctOptionId: "ttl",
    explanation:
      "Marking a task unhealthy changes what the registry returns for new queries. It does not reach into resolver caches. A resolver that cached the answer just before the replacement may keep using it for the remaining TTL. Client libraries and connection pools can extend the exposure further.",
  },
  setup: defaults({ dnsTtlSeconds: 120, taskLifetimeSeconds: 60, healthDetectionSeconds: 5, healthCoverage: 100 }),
  runFor: 30,
  observe: [
    "The cached staleness window is the full 120-second TTL; health detection does not shorten an answer already cached.",
    "Stale lookups rise toward 100% because tasks live half as long as the TTL.",
    "Request errors track the stale share: the registry is correct, but callers are not asking it.",
    "A 10-second TTL and longer task lifetime bring both metrics back to healthy.",
  ],
  explain:
    "Service discovery is a name-to-address mapping with a cache at every layer. The registry is only one copy. TTL bounds how long a compliant resolver may reuse an answer, so a long TTL makes a replacement invisible for that long. Health checks decide whether a dead task is removed from new answers; they do not invalidate old ones.",
  fix: defaults({ dnsTtlSeconds: 10, taskLifetimeSeconds: 300, healthDetectionSeconds: 5, healthCoverage: 100 }),
  debrief:
    "With a 10-second TTL the stale window is 10 seconds and the error rate falls below the warning line. The tradeoff is query volume: every caller refreshes more often, and the resolver has to answer more. The right TTL comes from how fast tasks change and how much error the caller can absorb, not from a default value.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Service discovery is a stable name for a set of tasks whose IP addresses change. Instead of configuring checkout at 10.0.4.17, the caller resolves checkout.internal and receives the addresses of the tasks that are currently registered. When a task is replaced, the registry changes the answer, and the caller does not need a configuration change.",
  },
  {
    type: "p",
    text: "Amazon Elastic Container Service (ECS) can register tasks with AWS Cloud Map, which provides a private DNS namespace and a registry of service instances. The registry is authoritative, but resolution passes through caches. A resolver, a client library, and an open connection can each keep using an address after the registry has moved on. Discovery therefore has two clocks: when the registry changes, and when the caller notices.",
  },
  {
    type: "table",
    headers: ["Layer", "What it knows", "What can go stale"],
    rows: [
      ["Registry", "Current service instances and their attributes", "Nothing, if health checks and deregistration run"],
      ["DNS answer", "A set of addresses with a time to live (TTL)", "The answer until the TTL expires"],
      ["Resolver cache", "Answers shared by many callers", "The answer until its own TTL expires"],
      ["Client library", "Addresses or connections held by one process", "Potentially longer than the DNS TTL"],
      ["Open connection", "One task's socket", "Until the connection closes or times out"],
    ],
  },
  {
    type: "p",
    text: "A TTL is a permission to cache, not a promise that every client will re-resolve. Many runtimes cache DNS internally, and HTTP clients reuse connections without consulting DNS at all. That is why a service can look correct in the registry while callers still fail during a deployment.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Discovery sits between the caller and the task's elastic network interface. The caller resolves a name, chooses an address, opens a connection, and sends a request. The registry sits beside the ECS service scheduler: as tasks start and stop, the scheduler registers and deregisters them. Health checks decide whether an unhealthy task is removed from new answers.",
  },
  {
    type: "p",
    text: "The placement of the health check matters. A check that runs inside the task can see the application, while a check run by the registry can only see the network path. A task can be healthy to one and unhealthy to the other. The caller experiences the combination: whether the address is returned, whether the connection succeeds, and whether the request is answered.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stale lookups: the share of resolutions that return a task which has already been replaced.",
      "Request errors from stale answers, which rise as the TTL grows relative to task lifetime.",
      "The maximum cached staleness, which is the DNS TTL.",
      "Health coverage: tasks that are registered without a health check can stay discoverable while dead.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Frequent deploys to see a normal TTL become too long for the replacement rate. Apply Stale rotation to combine a long TTL with short task lifetimes and incomplete health coverage. Apply Recovery to shorten the TTL and cover every task, then run the experiment before the debrief.",
  },
  { type: "sim", simId: "service-discovery" },
  { type: "experiment", experimentId: "predict-stale-window" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The caller kept resolving a stable name, but the answer behind it changed faster than the cache could follow. In the failure preset, a 120-second TTL outlived a 60-second task, so nearly every cached answer eventually pointed at a replaced task. Health detection marked tasks unhealthy, but that action only affected new queries. Incomplete health coverage added a second source of dead addresses that never left the registry.",
  },
  {
    type: "p",
    text: "The recovery preset shortened the TTL to 10 seconds and lengthened the task lifetime to 300 seconds. The stale window dropped to 10 seconds and the error rate fell below the warning threshold. The registry did not become faster; the caller started asking it more often.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Connection errors clustered around deployments or scale events, not steady-state traffic.",
      "The registry showing the correct task list while some callers still report the old IP.",
      "DNS query volume rising after a TTL reduction, sometimes enough to matter to a shared resolver.",
      "Tasks registered without health checks, visible as instances that remain after the application stops.",
      "Client-side connection pools keeping a dead task's address in use after DNS has moved on.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the record TTL with the task replacement rate, then check whether every registered task has a health check. After that, inspect the caller: its DNS cache, connection pool, and retry behavior can outlive the record. Do not assume the registry is wrong just because a caller reached a dead IP.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the failure happens during task churn, not at a fixed rate all day.",
      "Check the registry for dead instances and confirm health checks cover every task.",
      "Compare the TTL with the average task lifetime and the deployment frequency.",
      "Shorten the TTL for names that must follow churn, and measure the extra query load.",
      "Make callers tolerate a failed connection: bounded retries, no unbounded connection reuse.",
      "Re-test during a deployment, because that is when the stale window is exercised.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short TTL fails over faster and increases DNS query volume.",
      "A long TTL reduces query load and keeps dead addresses reachable longer.",
      "Health checks remove bad tasks from new answers but add check traffic and a detection delay.",
      "Client-side caching improves latency and can defeat the TTL you configured.",
      "Health-check detection time keeps a failing task discoverable a little longer; it does not extend a cached DNS answer.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stable-name",
    question:
      "A service calls a dependency by IP address. A task replacement breaks it every deploy. What do you change, and what does that not solve?",
    difficulty: 2,
    hints: [
      "The address changes; the name can stay stable.",
      "Resolution still passes through caches.",
    ],
    answer:
      "I would register the dependency with service discovery and call it by a stable name. That removes the hard-coded address from configuration and lets the registry follow task replacements. It does not solve stale answers: resolvers, client libraries, and connection pools can keep using an old address until their cache or connection expires. I would set the TTL from the task replacement rate, health-check every registered task, and verify the caller re-resolves during a deployment. I would also keep bounded retries for the window between a task stopping and the caller noticing.",
    followUps: [
      "How would you measure the stale window?",
      "What does a health check remove that a TTL does not?",
      "When would a load balancer be a better stable endpoint?",
    ],
    redFlags: [
      "Assumes DNS changes propagate instantly.",
      "Ignores client-side caching.",
      "Chooses a TTL without knowing the churn rate.",
    ],
    rubric: [
      "Replaces the fixed address with a stable name.",
      "Explains cache and connection staleness.",
      "Chooses TTL from churn.",
      "Adds health checks and retry tolerance.",
    ],
  },
  {
    id: "ttl-choice",
    question:
      "How do you choose a DNS TTL for an ECS service that is deployed several times a day?",
    difficulty: 2,
    hints: [
      "The TTL bounds how long a dead task remains reachable.",
      "Query volume is the cost of a short TTL.",
    ],
    answer:
      "I would start from the deployment and replacement rate, then compare the TTL with the error budget and the caller's tolerance. If tasks are replaced every few minutes, a TTL of several minutes leaves a large stale window. I would shorten it, measure the query increase, and confirm the resolver can handle it. If the TTL has to stay high, I would make the caller resilient to a failed connection and remove dead tasks from the registry quickly. The TTL is a trade between failover speed and query volume, not a fixed best practice.",
    followUps: [
      "What happens to query volume when the TTL drops from 60 to 10 seconds?",
      "How does a client library cache change the answer?",
      "Would you use the same TTL for a database endpoint?",
    ],
    redFlags: [
      "Quotes a default TTL without context.",
      "Ignores query volume.",
      "Assumes every client honors the TTL.",
    ],
    rubric: [
      "Relates TTL to replacement rate.",
      "Names the query-volume cost.",
      "Accounts for client caching.",
      "States a verification step.",
    ],
  },
  {
    id: "health-vs-ttl",
    question:
      "A task is unhealthy but still returned by service discovery. Is that a health-check problem or a TTL problem?",
    difficulty: 3,
    hints: [
      "Health checks decide whether the task is removed from new answers.",
      "TTL decides how long an old answer survives.",
    ],
    answer:
      "It can be both, and the order matters. If the task has no health check, it stays registered and new queries return it regardless of TTL, so the first fix is to cover it with a health check. If the task is health-checked and removed from the registry but a caller still reaches it, the caller is using a cached answer or an open connection, which is a TTL and client-behavior problem. I would confirm the registry state first, then test resolution from a caller. The fixes are different: coverage versus cache lifetime.",
    followUps: [
      "Which check would you use for a task that only fails some requests?",
      "How does health-check detection time interact with a cached DNS answer?",
      "What signal proves the registry removed the task?",
    ],
    redFlags: [
      "Changes the TTL when the task was never health-checked.",
      "Assumes the registry is always the source of the stale answer.",
      "Disables health checks to reduce noise.",
    ],
    rubric: [
      "Separates registration health from cache lifetime.",
      "Checks registry state before changing TTL.",
      "Tests from the caller.",
      "Chooses the right fix for each cause.",
    ],
  },
];

const checklist = [
  {
    title: "Before the service ships",
    items: [
      "The caller uses a stable name, not a task IP or a task-specific hostname.",
      "Every registered task has a health check that tests the real serving path.",
      "The TTL is chosen from the expected replacement rate and the caller's error budget.",
      "The caller has bounded retries and a timeout for the replacement window.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Check whether failures cluster around deployments, scale events, or task restarts.",
      "Compare the registry's current instances with the address the caller is using.",
      "Check health coverage before changing the TTL.",
      "Check client-side DNS caching and connection reuse.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Measure the stale window with the production TTL and task lifetime.",
      "Record the query-volume change from any TTL adjustment.",
      "Add a deployment-time check that a caller re-resolves and reconnects.",
      "Review whether a load balancer would provide a more stable endpoint.",
    ],
  },
];

const references = [
  {
    title: "Service discovery for Amazon ECS",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How ECS registers tasks with Cloud Map and how callers resolve service names.",
  },
  {
    title: "What is AWS Cloud Map?",
    url: "https://docs.aws.amazon.com/cloud-map/latest/dg/what-is-cloud-map.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Namespaces, services, instances, and the registry model behind ECS service discovery.",
  },
  {
    title: "Amazon ECS service discovery configuration",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-discovery-configure.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Registering a service with a namespace, service, and DNS record configuration.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "service-discovery": {
      model: serviceDiscoveryModel,
      presets,
      instructions:
        "Start Healthy, then apply Frequent deploys and Stale rotation. Compare the TTL with the task lifetime, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Eight tasks, the stale-share formula, the 3-second smoothing, and the resolution-time values are teaching assumptions, not ECS or Cloud Map limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-cloud-map",
    "containers-services",
    "traffic-alb-target-groups",
    "containers-draining",
  ],
};
