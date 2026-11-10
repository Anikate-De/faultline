import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const FIXED_TAIL_MS = 25;

const params = [
  {
    id: "parallelBranches",
    label: "Parallel branches",
    min: 1,
    max: 8,
    step: 1,
    value: 4,
    unit: " calls",
    group: "Topology",
    help: "Independent calls fanned out by the gateway. Parallel branches add the maximum branch duration, not the sum.",
    format: "count" as const,
  },
  {
    id: "slowestBranchMs",
    label: "Slowest parallel branch",
    min: 10,
    max: 800,
    step: 10,
    value: 100,
    unit: " ms",
    group: "Topology",
    help: "Duration of the slowest awaited branch after the fan-in. The response waits for it, so it adds to the path.",
    format: "ms" as const,
  },
  {
    id: "syncWorkMs",
    label: "Service C self time",
    min: 10,
    max: 600,
    step: 10,
    value: 80,
    unit: " ms",
    group: "Synchronous path",
    help: "Work Service C performs itself before it calls the database. This time is on the critical path.",
    format: "ms" as const,
  },
  {
    id: "dependencyWaitMs",
    label: "Database wait",
    min: 10,
    max: 1_200,
    step: 10,
    value: 60,
    unit: " ms",
    group: "Synchronous path",
    help: "Time Service C spends blocked on the database. It is serialized inside the request even when the database is fast.",
    format: "ms" as const,
  },
  {
    id: "asyncWorkMs",
    label: "Service B work",
    min: 10,
    max: 1_200,
    step: 10,
    value: 200,
    unit: " ms",
    group: "Asynchronous path",
    help: "Work in Service B that is not awaited by the response. It can be the longest span while adding nothing to p99.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  branches: number;
  syncWork: number;
  wait: number;
  slowestBranch: number;
  asyncWork: number;
  critical: number;
  waitShare: number;
}

function compute(p: Params): Computed {
  const branches = Math.round(num(p, "parallelBranches", 4));
  const syncWork = num(p, "syncWorkMs", 80);
  const wait = num(p, "dependencyWaitMs", 60);
  const slowestBranch = num(p, "slowestBranchMs", 100);
  const asyncWork = num(p, "asyncWorkMs", 200);
  const critical = syncWork + wait + slowestBranch + FIXED_TAIL_MS;
  return {
    branches,
    syncWork,
    wait,
    slowestBranch,
    asyncWork,
    critical,
    waitShare: (wait / critical) * 100,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const pathHealth = healthFor(values.critical, 400, 800);
  const waitHealth = healthFor(values.waitShare, 45, 65);
  const asyncHealth = values.asyncWork >= 1_100 ? "warn" : "ok";
  const cSpan = values.syncWork + values.wait;
  const branchStart = FIXED_TAIL_MS + cSpan;
  const rawBranches = Array.from({ length: Math.max(0, values.branches - 1) }, (_, index) => {
    const duration = values.slowestBranch * (0.55 + index * 0.04);
    return {
      id: `branch-${index + 1}`,
      label: `Parallel branch ${index + 2}`,
      duration,
    };
  });
  const nodes: SimNode[] = [
    {
      id: "gateway",
      label: "Request gateway",
      kind: "service",
      health: pathHealth,
      utilization: clamp(values.critical / 1_500),
      sublabel: `server · 0–${values.critical.toFixed(0)}ms`,
      span: {
        start: 0,
        duration: values.critical,
        depth: 0,
        kind: "server",
        self: FIXED_TAIL_MS,
        critical: true,
      },
    },
    {
      id: "service-c",
      label: "Service C",
      kind: "service",
      health: pathHealth,
      utilization: clamp(cSpan / 1_200),
      sublabel: `${values.syncWork.toFixed(0)}ms self time (${cSpan.toFixed(0)}ms span)`,
      span: {
        start: FIXED_TAIL_MS,
        duration: cSpan,
        depth: 1,
        kind: "server",
        self: values.syncWork,
        critical: true,
      },
    },
    {
      id: "database",
      label: "Database call",
      kind: "db",
      health: waitHealth,
      utilization: clamp(values.wait / 800),
      sublabel: `client · ${values.wait.toFixed(0)}ms wait`,
      span: {
        start: FIXED_TAIL_MS + values.syncWork,
        duration: values.wait,
        depth: 2,
        kind: "client",
        self: values.wait,
        critical: true,
      },
    },
    {
      id: "branch-slowest",
      label: "Slowest branch",
      kind: "service",
      health: pathHealth,
      utilization: clamp(values.slowestBranch / 800),
      sublabel: `client · ${values.slowestBranch.toFixed(0)}ms`,
      span: {
        start: branchStart,
        duration: values.slowestBranch,
        depth: 1,
        kind: "client",
        self: values.slowestBranch,
        critical: true,
      },
    },
    ...rawBranches.map(
      (branch): SimNode => ({
        id: branch.id,
        label: branch.label,
        kind: "service",
        health: "ok",
        utilization: clamp(branch.duration / 800),
        sublabel: `client · ${branch.duration.toFixed(0)}ms, parallel`,
        span: {
          start: branchStart,
          duration: branch.duration,
          depth: 2,
          kind: "client",
          self: branch.duration,
          critical: false,
        },
      }),
    ),
    {
      id: "service-b",
      label: "Service B (async)",
      kind: "service",
      health: asyncHealth,
      utilization: clamp(values.asyncWork / 1_200),
      sublabel: `internal · ${values.asyncWork.toFixed(0)}ms, not awaited`,
      span: {
        start: 30,
        duration: values.asyncWork,
        depth: 1,
        kind: "internal",
        self: values.asyncWork,
        critical: false,
      },
    },
  ];
  return {
    t: 0,
    nodes,
    edges: [
      edge("gateway-c", "gateway", "service-c", 1, pathHealth),
      edge("c-database", "service-c", "database", 1, waitHealth),
      edge("gateway-branch", "gateway", "branch-slowest", 1, pathHealth),
      ...rawBranches.map((branch) =>
        edge(`gateway-${branch.id}`, "gateway", branch.id, 1, "ok"),
      ),
      edge("gateway-b", "gateway", "service-b", clamp(values.asyncWork / 1_200), asyncHealth, "async, not awaited"),
    ],
    metrics: [
      metric("critical-path", "End-to-end p99", values.critical, " ms", 400, 800, "ms"),
      metric("wait-share", "Dependency share of path", values.waitShare, "%", 45, 65, "percent"),
      metric("slowest-branch", "Slowest branch", values.slowestBranch, " ms", undefined, undefined, "ms"),
      metric("async-work", "Service B span", values.asyncWork, " ms", undefined, undefined, "ms"),
      metric("c-self-time", "Service C self time", values.syncWork, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `End-to-end p99 is ${values.critical.toFixed(0)}ms: ${values.syncWork.toFixed(0)}ms C self time, ${values.wait.toFixed(0)}ms database wait, ${values.slowestBranch.toFixed(0)}ms slowest branch, ${FIXED_TAIL_MS}ms tail. Service B is ${values.asyncWork.toFixed(0)}ms but off the path.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "critical-path",
    metricId: "critical-path",
    warn: 400,
    crit: 800,
    title: "End-to-end latency crossed the critical threshold",
    cause: "The synchronous chain is long enough to breach the SLO. The critical path is the sum of serialized work, the slowest awaited branch, and waits, not the longest individual span.",
    fix: "Shorten the serialized work on the critical path: reduce the wait, speed up the slowest branch, or move an independent step off the response path. Do not optimize async work the response ignores.",
    checkFirst: [
      "Walk the parent-child chain and sum only the spans the response waits for.",
      "Identify the largest self-time and the largest wait on that chain.",
      "Check whether any parallel branch exceeds the current critical path.",
    ],
  },
  {
    id: "wait-share",
    metricId: "wait-share",
    warn: 45,
    crit: 65,
    title: "Most of the path is waiting, not working",
    cause: "The dependency wait dominates the request. Optimizing the caller's CPU or the callee's self-time will not remove the blocked interval.",
    fix: "Reduce the dependency latency, move the call off the synchronous path, cache the result, or parallelize it with other independent work.",
    checkFirst: [
      "Compare the client span duration with the server span duration.",
      "Check whether the dependency is queueing or doing slow work.",
      "Compare the slowest branch with the serialized self time before it.",
    ],
  },
];

export const traceCriticalPathModel: SimModel = {
  id: "observability-trace-critical-path",
  visual: "trace",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = 1 + rng.between(-0.005, 0.005);
    next.metrics = next.metrics.map((item) =>
      item.id === "wait-share" ? { ...item, value: item.value * jitter } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.critical >= 800 && frame.flags.pathFailureSeen !== 1) {
      pushEvent(next, {
        id: "critical-path-wait",
        at: frame.t,
        severity: "crit",
        title: "Critical path is dominated by a wait",
        detail: `End-to-end p99 is ${values.critical.toFixed(0)}ms; ${values.wait.toFixed(0)}ms is the database wait and ${values.slowestBranch.toFixed(0)}ms is the slowest branch. Service B is ${values.asyncWork.toFixed(0)}ms but is not awaited.`,
        nodeId: "service-c",
        metricId: "critical-path",
      });
      next.flags.pathFailureSeen = 1;
    }
    if (values.critical < 800) next.flags.pathFailureSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `End-to-end p99 is ${values.critical.toFixed(0)}ms: ${values.syncWork.toFixed(0)}ms C self time, ${values.wait.toFixed(0)}ms database wait, ${values.slowestBranch.toFixed(0)}ms slowest branch, ${FIXED_TAIL_MS}ms tail. Service B is ${values.asyncWork.toFixed(0)}ms but off the path.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(`The response waits ${values.critical.toFixed(0)}ms: ${values.syncWork.toFixed(0)}ms of Service C self time, ${values.wait.toFixed(0)}ms on the database, ${values.slowestBranch.toFixed(0)}ms on the slowest branch, and ${FIXED_TAIL_MS}ms of shared tail.`);
    items.push(`${values.branches} parallel branches run together, so only the slowest branch adds to the path; the others finish earlier and are not marked critical.`);
    items.push(`Service B is ${values.asyncWork.toFixed(0)}ms. Because the response does not wait for it, removing that work changes p99 by zero.`);
    items.push(`The database wait is ${values.waitShare.toFixed(0)}% of the path. If that share is high, self-time optimization in Service C has a small ceiling.`);
    return items;
  },
  legend: [
    { label: "On the path", tone: "ok" },
    { label: "Waiting", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Short serialized work, a 60ms database wait, a 100ms slowest branch, and async work the response ignores.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Heavy fan-out",
    description: "Six branches, longer self time, a 200ms wait, and a 140ms slowest branch. The path is close to the SLO.",
    tone: "warn",
    params: defaults({ parallelBranches: 6, syncWorkMs: 120, dependencyWaitMs: 200, slowestBranchMs: 140, asyncWorkMs: 300 }),
  },
  {
    id: "failure",
    label: "Waiting on the database",
    description: "Service B is 900ms but off the path; a 700ms database wait and a 160ms branch serialize the response.",
    tone: "crit",
    params: defaults({ parallelBranches: 6, syncWorkMs: 140, dependencyWaitMs: 700, slowestBranchMs: 160, asyncWorkMs: 900 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The database wait falls to 40ms and the slowest branch to 80ms. Service B stays off the path.",
    tone: "ok",
    params: defaults({ parallelBranches: 4, syncWorkMs: 70, dependencyWaitMs: 40, slowestBranchMs: 80, asyncWorkMs: 200 }),
  },
];

const experiment: Experiment = {
  id: "predict-critical-path-fix",
  title: "Predict which optimization lowers p99",
  simId: "trace-critical-path",
  question:
    "Service B takes 900ms, Service C has 140ms self time inside an 840ms span, and the response takes 1025ms. Which change lowers end-to-end latency the most?",
  prediction: {
    options: [
      { id: "service-b", label: "Cut Service B in half, because it is the longest span" },
      { id: "service-c", label: "Cut Service C's self time in half" },
      { id: "wait", label: "Remove most of the 700ms database wait inside Service C" },
      { id: "branches", label: "Add more parallel branches to spread the load" },
    ],
    correctOptionId: "wait",
    explanation:
      "The response does not wait for Service B, so its duration is off the critical path. Service C is on the path with 140ms of self time and 700ms of database wait, and the slowest branch adds another 160ms. Removing 660ms of the wait lowers the 1025ms path to 365ms, while cutting Service B changes nothing.",
  },
  setup: defaults({ parallelBranches: 4, syncWorkMs: 140, dependencyWaitMs: 700, slowestBranchMs: 160, asyncWorkMs: 900 }),
  runFor: 20,
  observe: [
    "End-to-end p99 is 1025ms while Service B's span is 900ms.",
    "The database wait is 68% of the critical path.",
    "Service C's 140ms self time sits inside an 840ms span.",
    "The slowest parallel branch adds 160ms and is marked critical.",
    "The Service B node stays healthy because the response does not await it.",
  ],
  explain:
    "The critical path is the longest chain of work the response must finish. Parallel branches contribute their maximum, and asynchronous work contributes nothing. Service C owns 140ms of self time but spends 700ms waiting on the database. The slowest branch is serialized after that chain. The longest span is a scheduling fact; the critical path is a dependency fact.",
  fix: defaults({ parallelBranches: 4, syncWorkMs: 140, dependencyWaitMs: 40, slowestBranchMs: 160, asyncWorkMs: 900 }),
  debrief:
    "Removing the wait drops p99 to 365ms and leaves Service B at 900ms. The recovery is real but narrow: the next-largest term is the 160ms slowest branch, then Service C's 140ms self time, then the 25ms tail. If the database cannot be made faster, moving the call off the synchronous path or caching the result changes the dependency graph, not just a number. Each option adds complexity or freshness risk.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The critical path is the longest chain of dependent work between the start and end of a request. Only work on that chain can change end-to-end latency. A span's duration is not the same as its contribution: a parent span includes its children, and a child that runs in parallel with another does not add its full duration to the total.",
  },
  {
    type: "p",
    text: "Two derived quantities make the trace readable. Self time is the part of a span not covered by any child: the work the service actually performed. Wait time is the part of a span spent blocked on a dependency, a lock, a queue, or a connection. A span can be long because it is doing work, because it is waiting, or because it contains a slow child. The waterfall alone does not tell you which.",
  },
  {
    type: "p",
    text: "A request that fans out to several services waits for the slowest awaited branch, not the sum. A fire-and-forget call that is not awaited can be the longest span in the trace and still contribute nothing to p99. That is why an optimization can look obvious on a waterfall and produce no user-visible change.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The critical path is computed from the span tree, not from a list of durations. Start at the root, keep the parent-child links, and mark each child as awaited or not. For each awaited child, add its self time and wait time; for parallel children, take the maximum. Repeat until the leaves. The result is a chain, and every span on it is a candidate for optimization.",
  },
  {
    type: "table",
    headers: ["Measure", "What it includes", "What it answers"],
    rows: [
      ["Span duration", "Self time, child spans, and wait", "How long did this operation appear to take?"],
      ["Self time", "Work not covered by a child span", "How much CPU or I/O does this service own?"],
      ["Wait time", "Blocked interval inside the span", "What is this service waiting for?"],
      ["Critical path", "Longest chain of awaited work", "What can actually change end-to-end latency?"],
    ],
  },
  {
    type: "p",
    text: "The timings in this model are illustrative teaching values. They are not a benchmark or a vendor limit. The structure is the lesson: a 900ms async span, 140ms of Service C self time inside an 840ms span, a 160ms slowest branch, and a 700ms wait, where only the serialized terms are on the path.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "End-to-end p99: the critical path the user experiences.",
      "Dependency share of the path: how much of the total is blocked time.",
      "Service B's span: the longest span, included to show that duration alone misleads.",
      "Service C's self time: 140ms of work inside an 840ms span.",
      "The slowest parallel branch: the only branch that adds to the path.",
      "Critical-path markers and self-time overlays in the trace waterfall.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Waiting on the database. Find the longest span, then check whether the response awaits it. Run the experiment before the debrief: predict which change lowers p99, apply the fix, and compare the new critical path with the old one.",
  },
  {
    type: "compare",
    leftTitle: "Longest span",
    rightTitle: "Critical path",
    rows: [
      { label: "Definition", left: "Largest duration in the trace", right: "Longest awaited dependency chain" },
      { label: "Includes async work", left: "Yes", right: "No, if the response does not wait" },
      { label: "Parallel branches", left: "Each appears separately", right: "Only the slowest awaited branch counts" },
      { label: "Optimization value", left: "May be zero for p99", right: "Directly reduces end-to-end latency" },
      { label: "What it hides", left: "Self time versus waiting", right: "Work outside the traced path" },
    ],
  },
  { type: "sim", simId: "trace-critical-path" },
  { type: "experiment", experimentId: "predict-critical-path-fix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The trace contained a 900ms Service B span, 140ms of Service C self time inside an 840ms span, and a 160ms slowest branch. The response took 1025ms because it waited for the serialized service work, database wait, and slowest branch. Service B was longer but asynchronous, so cutting it would not move p99. The critical path made the difference between the two visible.",
  },
  {
    type: "p",
    text: "Removing 660ms of the database wait dropped p99 to 365ms. Service B stayed at 900ms and stayed off the path. The next constraint is the 160ms slowest branch, then Service C's 140ms self time, then the 25ms shared tail. Recovery moved the bottleneck rather than eliminating it, which is the normal outcome.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Trace waterfall: parent and child timings, plus gaps where no child span exists.",
      "Service graphs: a call edge that is awaited versus one that is fire-and-forget.",
      "APM span metrics: self time and wait time by service, not just total duration.",
      "Database dashboards: query latency and connection pool wait, which may be the real serialized dependency.",
      "Saturation signals: CPU high on a service that is not on the path is a capacity problem, not a latency cause.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Mark the spans the response awaits. Sum self time and wait along that chain, and take the maximum across parallel branches. If the biggest span is not on the chain, it is not your latency fix, even if it is the most visible number.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Draw the awaited chain and exclude async or parallel work that does not block the response.",
      "Split each span on the chain into self time and wait time.",
      "Reduce the largest wait first: fix the dependency, cache it, or move the call off the synchronous path.",
      "If self time dominates, optimize the code or add capacity on the service that owns it.",
      "If serialization dominates, move independent work into parallel branches and verify the tail.",
      "Re-measure end-to-end p99, not the optimized span, and check the next largest term.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Optimizing an off-path span can still reduce resource use or help a different request shape, but it will not lower this p99.",
      "Parallelizing work adds coordination, partial-failure handling, and a new tail; the slowest branch becomes the constraint.",
      "Caching a dependency removes wait and adds freshness risk and invalidation work.",
      "Moving work off the synchronous path improves latency and can hide failures from the user until a later step.",
      "A critical path is only as complete as the trace; an uninstrumented dependency becomes an invisible gap.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-critical-path",
    question:
      "Given a trace with parallel branches, how do you compute the critical path, and what do you exclude?",
    difficulty: 3,
    hints: [
      "Start from the root and follow only awaited children.",
      "Parallel branches contribute the maximum, not the sum.",
    ],
    answer:
      "I start at the root and keep the parent-child structure. For each span I separate self time from child time, and I mark whether the caller awaits the child. Awaited serial children add their duration; parallel awaited children contribute the maximum branch; fire-and-forget children contribute nothing to the response path. I repeat until the leaves, which gives a chain and a total. I exclude work that is not awaited, work that happens after the response, and any span that is not causally connected to the root.",
    followUps: [
      "How would you handle a branch that is awaited only on an error path?",
      "What if two children overlap partially?",
      "How does retry time appear on the path?",
    ],
    redFlags: [
      "Sorts spans by duration.",
      "Sums all children, including parallel ones.",
      "Includes async work that the response ignores.",
    ],
    rubric: [
      "Uses parent-child structure.",
      "Separates serial, parallel, and async.",
      "Produces a chain, not just a number.",
    ],
  },
  {
    id: "self-vs-wait",
    question:
      "A service span is 800ms and its CPU is 20%. Its child database span is 650ms. Where did the time go, and what would you optimize?",
    difficulty: 2,
    hints: [
      "A parent span includes its children.",
      "Low CPU with a long child span points to waiting.",
    ],
    answer:
      "The parent's 800ms includes the 650ms child, so its self time is about 150ms. The service is mostly waiting on the database, not burning CPU. I would optimize the database call or reduce the number of serial calls before I touched the service's code. I would confirm with the client span duration, connection pool wait, and database query latency, because a client span can also include network and pool time.",
    followUps: [
      "What if the child span is only 50ms?",
      "How would connection pool wait appear in the trace?",
      "What would you check if CPU were 95%?",
    ],
    redFlags: [
      "Blames the service because its span is longest.",
      "Ignores child time.",
      "Optimizes CPU without checking the dependency.",
    ],
    rubric: [
      "Subtracts child time to get self time.",
      "Uses CPU as corroboration.",
      "Checks pool and network effects.",
    ],
  },
  {
    id: "off-path-work",
    question:
      "Service B is the slowest span in every trace, but optimizing it does not improve p99. How do you explain that to the team?",
    difficulty: 2,
    hints: [
      "Check whether the response awaits Service B.",
      "Span duration is not the same as critical-path contribution.",
    ],
    answer:
      "I would show the parent-child chain and mark Service B as asynchronous or parallel. If the response does not wait for it, its duration cannot add to end-to-end latency. I would also check whether it shares a resource such as a connection pool or CPU with the critical path; in that case, optimizing it can still help indirectly. If it is truly off-path, the team should optimize it for capacity, cost, or a different request shape, not for this p99.",
    followUps: [
      "When could off-path work still affect latency?",
      "How would you prove the response does not await it?",
      "What would you measure to show the improvement?",
    ],
    redFlags: [
      "Assumes the longest span is the cause.",
      "Ignores shared resources.",
      "Optimizes without a p99 measurement plan.",
    ],
    rubric: [
      "Distinguishes off-path from on-path.",
      "Checks shared resource effects.",
      "Ties the optimization to the right goal.",
    ],
  },
  {
    id: "serialization",
    question:
      "Three independent 100ms calls run serially in a 500ms request. What is the critical path, and what changes if you run them in parallel?",
    difficulty: 2,
    hints: [
      "Serial calls add; parallel calls take the maximum.",
      "Account for coordination overhead and partial failure.",
    ],
    answer:
      "Serially, the three calls contribute 300ms to the path. If they are truly independent and the response awaits all of them, running them in parallel reduces that contribution to about 100ms plus coordination overhead. The new critical path is the slowest call plus any shared tail. The tradeoff is more concurrent connections, partial-failure handling, and a tail where one slow call still sets the latency. I would verify that the calls do not depend on each other's outputs before parallelizing.",
    followUps: [
      "What if one call must complete before another starts?",
      "How would you handle one branch failing?",
      "What does the fan-out do to connection pools?",
    ],
    redFlags: [
      "Parallelizes dependent calls.",
      "Ignores coordination and failure handling.",
      "Assumes the sum disappears entirely.",
    ],
    rubric: [
      "Adds serial work and takes the max for parallel work.",
      "Checks dependency ordering.",
      "Names the new tail and failure handling.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Traces show parent-child links and span kind, not only durations.",
      "Dashboards separate self time from wait time for the services on the user path.",
      "Async and fire-and-forget calls are labeled so they are not mistaken for blocking work.",
      "The p99 SLO is measured at the edge, not inferred from a service span.",
      "Connection pool wait and dependency latency are visible next to the trace.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Draw the awaited chain before choosing an optimization target.",
      "Find the largest self-time and wait-time terms on that chain.",
      "Check whether the longest span is parallel or asynchronous.",
      "Verify with a dependency dashboard before changing code.",
      "Re-measure end-to-end p99 after the change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the old and new critical path, not just the new p99.",
      "Check that the bottleneck did not move to a branch that was previously hidden.",
      "Add the missing span or attribute that made the diagnosis slow.",
      "Review whether the optimization added freshness or failure-handling risk.",
    ],
  },
];

const references = [
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Latency, saturation, and how a slow dependency propagates through a request path.",
  },
  {
    title: "Traces",
    url: "https://opentelemetry.io/docs/concepts/signals/traces/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Span structure, parent-child relationships, and span kinds.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "trace-critical-path": {
      model: traceCriticalPathModel,
      presets,
      instructions:
        "Start Healthy, then apply Waiting on the database. Find the longest span, check whether the response awaits it, then run the experiment and remove the wait.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Millisecond values and branch timing are teaching values, not a benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-distributed-tracing",
    "observability-continuous-profiling",
    "observability-golden-signals",
    "foundations-queueing-knee",
  ],
};
