import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_FDS = 180;

const params = [
  {
    id: "connectionRate",
    label: "New connections",
    min: 25,
    max: 1_200,
    step: 25,
    value: 200,
    unit: " conn/s",
    group: "Traffic",
    help: "Accepted connections per second. Each accepted socket and each upstream socket needs a descriptor.",
    format: "rps" as const,
  },
  {
    id: "connectionLifetime",
    label: "Connection lifetime",
    min: 1,
    max: 120,
    step: 1,
    value: 15,
    unit: " s",
    group: "Traffic",
    help: "How long a connection stays open. Concurrent sockets are approximately rate multiplied by lifetime.",
    format: "number" as const,
  },
  {
    id: "leakPerMinute",
    label: "Descriptor leak rate",
    min: 0,
    max: 6_000,
    step: 60,
    value: 0,
    unit: " fds/min",
    group: "Failure",
    help: "Descriptors never returned on an error path. The leak accumulates until the process exits or is restarted.",
    format: "count" as const,
  },
  {
    id: "fdLimit",
    label: "Process fd limit",
    min: 256,
    max: 131_072,
    step: 256,
    value: 8_192,
    unit: " fds",
    group: "Limits",
    help: "The soft RLIMIT_NOFILE for the process. The hard limit is the ceiling it can be raised to.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  attemptedFds: number;
  openFds: number;
  utilization: number;
  errorPct: number;
  exhausted: boolean;
  connectionRate: number;
  leaked: number;
  limit: number;
  headroom: number;
  growthPerSecond: number;
  secondsToLimit: number;
}

function compute(p: Params, leaked: number): Computed {
  const connectionRate = num(p, "connectionRate", 200);
  const lifetime = num(p, "connectionLifetime", 15);
  const leakPerMinute = num(p, "leakPerMinute", 0);
  const limit = Math.max(128, num(p, "fdLimit", 8_192));
  const attemptedFds = BASE_FDS + connectionRate * lifetime + leaked;
  const openFds = Math.min(limit, attemptedFds);
  const utilization = (openFds / limit) * 100;
  const exhausted = attemptedFds >= limit;
  const errorPct = exhausted ? 100 : 0;
  const growthPerSecond = leakPerMinute / 60;
  const headroom = Math.max(0, limit - attemptedFds);
  return {
    attemptedFds,
    openFds,
    utilization,
    errorPct,
    exhausted,
    connectionRate,
    leaked,
    limit,
    headroom,
    growthPerSecond,
    secondsToLimit: growthPerSecond > 0 ? headroom / growthPerSecond : Number.POSITIVE_INFINITY,
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 90) return "crit";
  if (utilization >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, leaked: number): SimFrame {
  const values = compute(p, leaked);
  const health = healthFor(values.utilization);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: "new + reused connections",
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: "ok",
        sublabel: "accepts and forwards",
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Service process",
        kind: "service",
        health,
        utilization: clamp(values.utilization / 100),
        throughput: values.connectionRate,
        capacity: values.limit,
        sublabel: `${Math.round(values.openFds).toLocaleString()} open / ${Math.round(values.attemptedFds).toLocaleString()} attempted`,
        detail: `${values.utilization.toFixed(0)}% of the ${values.limit.toLocaleString()} descriptor limit. Descriptor demand is ${Math.round(values.attemptedFds).toLocaleString()}; the table holds at most the limit, and accept() fails once demand reaches it.`,
        meta: { view: "flow", utilization: values.utilization },
      },
      {
        id: "fdtable",
        label: "Descriptor table",
        kind: "storage",
        role: "instance",
        health,
        utilization: clamp(values.utilization / 100),
        sublabel: `${Math.round(values.headroom).toLocaleString()} free`,
        detail: "The per-process table maps small integers to open file descriptions. It cannot hold more than the soft limit; accept() returns EMFILE when no slot is free.",
        meta: { view: "flow" },
      },
      {
        id: "upstream",
        label: "Upstream dependency",
        kind: "external",
        health: "ok",
        sublabel: "one socket per pool connection",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.connectionRate / 1_200)),
      edge("lb-app", "lb", "app", clamp(values.connectionRate / 1_200), health),
      edge("app-table", "app", "fdtable", clamp(values.utilization / 100), health),
      edge("app-upstream", "app", "upstream", clamp(values.connectionRate / 2_400)),
    ],
    metrics: [
      metric("fd-utilization", "Descriptor limit used", values.utilization, "%", 70, 90, "percent"),
      metric("open-fds", "Open descriptors", values.openFds, " fds", undefined, undefined, "count"),
      metric("attempted-fds", "Descriptor demand", values.attemptedFds, " fds", undefined, undefined, "count"),
      metric("accept-errors", "Accept failures", values.errorPct, "%", 1, 10, "percent"),
      metric("connection-rate", "New connections", values.connectionRate, " conn/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, leaked, paramsKey: JSON.stringify(p) },
    summary: `${values.utilization.toFixed(0)}% of descriptors used; ${Math.round(values.attemptedFds).toLocaleString()} demanded; ${values.errorPct.toFixed(0)}% accept failures.`,
  };
  const seedJitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 11)) / 3.1);
  frame.series["fd-utilization"] = Array.from({ length: 20 }, (_, index) =>
    Math.max(0, Math.min(100, values.utilization * seedJitter(index))),
  );
  frame.series["attempted-fds"] = Array.from({ length: 20 }, (_, index) =>
    Math.max(0, values.attemptedFds * seedJitter(index + 2)),
  );
  return frame;
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds)) return "no projected crossing";
  if (seconds > 3_600) return "over an hour";
  return `${Math.round(seconds)}s`;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "fd-utilization",
    metricId: "fd-utilization",
    warn: 70,
    crit: 90,
    title: "The process is running out of file descriptors",
    cause:
      "Open descriptors reached the process soft limit. A leak, a traffic spike, or a connection lifetime increase can fill the table; new accept() calls then fail with EMFILE.",
    fix:
      "Restore service first by draining or restarting the leaking process, then fix the close path. Raising the limit adds headroom but does not change the slope of a leak.",
    checkFirst: [
      "Graph the open fd count and its slope, not only utilization.",
      "Find which descriptor types dominate: sockets, files, pipes, or eventpoll.",
      "Check whether the leak began with a deploy or an error-path change.",
    ],
  },
  {
    id: "accept-errors",
    metricId: "accept-errors",
    warn: 1,
    crit: 10,
    title: "New connections are being refused",
    cause:
      "The listener has no free descriptor for an accepted socket. Existing connections may still work, which makes the service look healthy while new clients fail.",
    fix:
      "Confirm EMFILE in the service log, free descriptors or restart to recover, and add an alert on accept failures. Then remove the leak before raising limits.",
    checkFirst: [
      "Check the accept loop error and errno.",
      "Compare open fds with the soft and hard limits.",
      "Check whether the load balancer reports backend connection errors.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const fdModel: SimModel = {
  id: "foundations-file-descriptors",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed, 0),
  step: (frame, p, dt) => {
    const leaked = Number(frame.flags.leaked ?? 0) + (num(p, "leakPerMinute", 0) / 60) * dt;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), leaked);
    const values = compute(p, leaked);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, leaked };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.exhausted && frame.flags.fdCrit !== 1) {
      pushEvent(next, {
        id: "fd-limit-near",
        at: frame.t,
        severity: "crit",
        title: "Descriptor table is full",
        detail: `${values.limit.toLocaleString()} descriptors are open and demand is ${Math.round(values.attemptedFds).toLocaleString()}. ${values.growthPerSecond > 0 ? `The leak adds ${values.growthPerSecond.toFixed(0)} fd/s.` : "No leak is adding descriptors."}`,
        nodeId: "app",
        metricId: "fd-utilization",
      });
      next.flags.fdCrit = 1;
    }
    if (!values.exhausted) next.flags.fdCrit = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.utilization.toFixed(0)}% of descriptors used; ${Math.round(values.attemptedFds).toLocaleString()} demanded; ${values.errorPct.toFixed(0)}% accept failures.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, Number(frame.flags.leaked ?? 0));
    const items: string[] = [];
    items.push(
      `${Math.round(values.openFds).toLocaleString()} descriptors are held by sockets and files; the process limit is ${values.limit.toLocaleString()}.`,
    );
    if (values.growthPerSecond > 0 && values.exhausted) {
      items.push(
        `The table is full. Raising the limit only buys time proportional to the added headroom; the leak adds ${Math.round(values.growthPerSecond)} fds/s regardless.`,
      );
    } else if (values.growthPerSecond > 0) {
      items.push(
        `The leak adds ${Math.round(values.growthPerSecond)} fds/s, so raising the limit only buys ${formatSeconds(values.secondsToLimit)} before the same failure.`,
      );
    } else {
      items.push("With no leak, descriptor use is set by connection rate multiplied by connection lifetime.");
    }
    if (values.exhausted) {
      items.push(
        `Demand is ${Math.round(values.attemptedFds).toLocaleString()} descriptors against a ${values.limit.toLocaleString()} limit, so accept failures are 100% and existing connections continue.`,
      );
    } else if (values.utilization >= 70) {
      items.push(
        `${values.utilization.toFixed(0)}% of the table is used; about ${Math.round(values.headroom).toLocaleString()} descriptors remain before refusals begin.`,
      );
    }
    items.push(
      `Cutting connection lifetime or adding keep-alive reduces concurrent sockets; changing the limit only moves the boundary.`,
    );
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
    description: "Modest churn and a comfortable descriptor margin.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High churn with long-lived sockets. Headroom is thin but the process still accepts.",
    tone: "warn",
    params: defaults({ connectionRate: 420, connectionLifetime: 16 }),
  },
  {
    id: "failure",
    label: "Descriptor leak",
    description: "A small steady leak accumulates under normal traffic until accept() fails.",
    tone: "crit",
    params: defaults({ connectionRate: 260, connectionLifetime: 12, leakPerMinute: 4_800, fdLimit: 4_096 }),
  },
  {
    id: "raise-limit",
    label: "Raise the limit",
    description: "Double the fd limit but keep the leak. The failure moves later, not away.",
    tone: "warn",
    params: defaults({ connectionRate: 260, connectionLifetime: 12, leakPerMinute: 4_800, fdLimit: 8_192 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Leak closed, churn reduced, and a sane soft limit restored.",
    tone: "ok",
    params: defaults({ connectionRate: 200, connectionLifetime: 8, leakPerMinute: 0, fdLimit: 8_192 }),
  },
];

const experiment: Experiment = {
  id: "predict-fd-limit",
  title: "Does doubling the limit prevent the outage?",
  simId: "fd",
  question:
    "A process leaks 4,800 descriptors per minute under steady traffic. If you double the soft limit, what happens?",
  prediction: {
    options: [
      { id: "prevents", label: "The leak stops causing failures" },
      { id: "delays", label: "Failure is delayed, then returns at the same slope" },
      { id: "worse", label: "The process fails sooner" },
      { id: "no-effect", label: "Nothing changes at all" },
    ],
    correctOptionId: "delays",
    explanation:
      "The limit is a boundary, not a fix. Doubling it gives the same leak more room, so the crossing moves later while the descriptor count keeps climbing at the same rate. A restart resets the count; only closing the leaked descriptors changes the slope.",
  },
  setup: defaults({ connectionRate: 260, connectionLifetime: 12, leakPerMinute: 4_800, fdLimit: 4_096 }),
  runFor: 40,
  observe: [
    "Descriptor demand rises in a straight line while traffic is steady.",
    "Utilization crosses 70% and 90% even though connection rate never changes.",
    "Accept failures appear only after the table is effectively full.",
    "Open descriptors cap at the limit while demand keeps climbing; the doubled limit moves the cap later.",
  ],
  explain:
    "A descriptor leak is cumulative. The soft limit determines when the next accept() gets EMFILE, and the hard limit determines how far the soft limit can be raised. Neither changes how fast descriptors are lost. Raising the limit is a valid short-term control only when paired with a restart or a fix, because the leak will consume the new headroom at the same rate.",
  fix: defaults({ connectionRate: 220, connectionLifetime: 10, leakPerMinute: 0, fdLimit: 8_192 }),
  debrief:
    "The recovered run is flat because no descriptors are lost. The tradeoff is that the leak fix requires finding the error path that returns early without close(), which is slower than raising a limit. Keep the higher limit for legitimate peak concurrency, not as a substitute for the fix.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A file descriptor is a small integer that indexes an entry in a per-process table. Sockets, regular files, pipes, event loops, and inotify watches all consume one. The kernel returns the lowest free number from open(), socket(), accept(), or epoll_create(); close() releases it. A descriptor leak is a path that opens or accepts a resource and never closes it, so the table fills even when request volume is normal.",
  },
  {
    type: "p",
    text: "Two limits matter. RLIMIT_NOFILE is a per-process soft limit that the process can raise up to its hard limit. The system-wide fs.file-max and the container runtime or orchestrator may impose other ceilings. When the soft limit is reached, accept() fails with EMFILE (too many open files) and the listener cannot admit new connections. Existing connections keep working, so CPU, memory, and request success can all look healthy while new clients are refused.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, service process, then descriptor table. Each accepted client socket holds a descriptor for the life of the connection. Each upstream call may hold another. An epoll (Linux event notification) instance holds a descriptor and registers many sockets without consuming one descriptor per registration, but the sockets themselves still count. A typical request therefore costs at least two descriptors while it is in flight.",
  },
  {
    type: "table",
    headers: ["Limit", "Scope", "What happens when reached"],
    rows: [
      ["RLIMIT_NOFILE soft", "One process", "open/accept return EMFILE; the process can raise it up to the hard limit"],
      ["RLIMIT_NOFILE hard", "One process", "Unprivileged processes cannot raise the soft limit further"],
      ["fs.file-max", "Host kernel", "System-wide allocation failures under extreme load"],
      ["Container or task ulimit", "Task or pod", "The process starts with the configured limit; check it, do not assume the host value"],
    ],
  },
  {
    type: "p",
    text: "The simulation models one service process at 25–1,200 new connections per second. Descriptor counts and limits are illustrative teaching values, not a claim about any particular runtime. The shape is the lesson: steady churn produces a plateau, a leak produces a slope, and the limit turns the slope into refusals.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Descriptor limit used: the percentage of the soft limit, with warning at 70% and critical at 90%.",
      "Open descriptors: the capped count actually held by the process.",
      "Descriptor demand: attempted descriptors, which keeps rising after the table is full and separates a leak from a plateau.",
      "Accept failures: 100% once demand reaches the soft limit, because no slot is available.",
      "Connection rate: the traffic input, held steady in the leak experiment so the slope is unmistakable.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy to see a stable plateau. Apply Descriptor leak and watch descriptor demand rise while connection rate stays flat. Then apply Raise the limit: the line keeps the same slope and only the crossing moves. Run the experiment before reading its explanation, then apply Recovery.",
  },
  {
    type: "table",
    headers: ["Signal", "Leak", "Traffic spike"],
    rows: [
      ["Open fds over time", "Rises steadily at constant load", "Rises with load, then plateaus"],
      ["Connection rate", "Unchanged", "Elevated"],
      ["After restart", "Returns to baseline, then climbs again", "Returns to baseline and stays"],
      ["Per-type breakdown", "One type grows without a matching workload", "Sockets scale with traffic"],
    ],
  },
  { type: "sim", simId: "fd" },
  { type: "experiment", experimentId: "predict-fd-limit" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The leak added descriptors that were never returned. Utilization rose linearly while traffic stayed constant, then accept() ran out of slots and refused new connections. Existing sessions continued, which is why the incident looked partial: some users were fine and new ones failed. Raising the limit moved the crossing later without changing the slope.",
  },
  {
    type: "p",
    text: "The recovery removed the leak, not just the symptom. Descriptor use fell to a plateau set by connection rate multiplied by lifetime, and accept failures disappeared. That distinction matters in production: a restart buys time, and a higher limit buys a little more, but both return to the same failure if the close path is still broken.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Linux: `ls /proc/PID/fd | wc -l`, `lsof -p PID`, and `cat /proc/PID/limits` show the count, owners, and soft/hard limits.",
      "Service logs: `accept4: too many open files`, `EMFILE`, or framework-specific connection errors that repeat in a burst.",
      "Load balancer: backend connection errors and a rising `TargetConnectionErrorCount` while target response time stays normal.",
      "ECS or Kubernetes: the task or pod ulimit, restart count, and the gap between requested and actual limits.",
      "Metrics: a process fd gauge with a slope alert, plus accept failure rate. Utilization alone hides whether the count is stable or climbing.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the process is at its soft limit, then graph the open fd count over time. A flat plateau points to legitimate concurrency; a straight line points to a leak. Check the per-type breakdown and the deploy timeline before changing any limit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the bleeding: restart or drain the leaking process, or remove it from the load balancer, so new connections can be accepted.",
      "Confirm EMFILE and the current soft and hard limits from the process itself, not from the host's shell.",
      "Find the descriptor type that grows and map it to the code path that opens it.",
      "Fix the missing close in the error path; use structured cleanup or defer/try-with-resources so every exit releases the resource.",
      "Raise the soft limit to a value justified by peak concurrency, and set it in the deployment spec so restarts are consistent.",
      "Add an alert on the fd slope and on accept failures, then load-test the path that previously leaked.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Raising the limit is fast and sometimes necessary, but it converts an immediate outage into a later one when a leak is present.",
      "Shorter connection lifetimes reduce concurrent sockets but add handshakes, CPU, and upstream churn.",
      "Aggressive keep-alive reduces new connections but holds descriptors open longer, which raises the steady-state plateau.",
      "A restart clears the symptom and loses in-flight work; it is a control, not a remediation.",
      "A per-process limit protects the host from one runaway process but makes that process the first to fail.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-emfile",
    question:
      "A service is healthy on CPU and memory, but new connections fail with EMFILE. How do you confirm descriptor exhaustion and find the cause?",
    difficulty: 2,
    hints: [
      "Check the process limit from inside the process namespace.",
      "Separate a stable plateau from a growing count.",
    ],
    answer:
      "I would confirm the process is at its soft RLIMIT_NOFILE by reading /proc/PID/limits, then count /proc/PID/fd and break it down with lsof by type. If sockets dominate and the count is flat, the limit is simply too low for the concurrency. If one type grows while traffic is flat, I look for an open path without a matching close, especially error returns, and correlate the start with a deploy. I would also check accept errors at the load balancer and whether the process is a container with a different ulimit than the host.",
    followUps: [
      "How would you tell a leak from a traffic spike?",
      "What does the hard limit change about your options?",
      "Why can existing connections keep working?",
    ],
    redFlags: [
      "Raises the limit without checking the slope.",
      "Assumes the host limit applies inside the container.",
      "Blames the network without checking EMFILE.",
    ],
    rubric: [
      "Names per-process limit and fd count.",
      "Distinguishes plateau from leak.",
      "Checks deployment and ulimit configuration.",
      "States a verification step.",
    ],
  },
  {
    id: "fix-versus-raise",
    question:
      "You can raise the fd limit or fix the close path. How do you decide under incident pressure, and what do you tell the team?",
    difficulty: 2,
    hints: [
      "Separate mitigation from remediation.",
      "The slope decides whether headroom is enough.",
    ],
    answer:
      "I treat them as different tools. Raising the limit or restarting is mitigation: it restores new connections while we investigate. Fixing the close path is remediation: it changes the slope. If the count is flat and the limit is genuinely undersized for peak concurrency, raising it is the correct durable fix. If the count rises at constant load, raising the limit only moves the outage, so I set a bounded window for the mitigation and keep the leak fix as the exit condition. I would also add a slope alert so the next occurrence pages earlier.",
    followUps: [
      "How much headroom would you add?",
      "What would you monitor during the mitigation window?",
      "How do you prevent the same leak in another service?",
    ],
    redFlags: [
      "Calls a limit increase a permanent fix for a leak.",
      "Restarts repeatedly without investigation.",
      "Ignores the deployment-time ulimit.",
    ],
    rubric: [
      "Separates mitigation and remediation.",
      "Uses the slope to choose.",
      "Defines an exit condition.",
      "Adds a preventive control.",
    ],
  },
  {
    id: "fd-and-epoll",
    question:
      "Does epoll remove the need for one descriptor per connection? Explain what epoll does and does not save.",
    difficulty: 3,
    hints: [
      "An epoll instance is itself a descriptor.",
      "Registrations are not descriptors.",
    ],
    answer:
      "No. epoll lets one thread wait on many sockets efficiently, and the epoll instance consumes a descriptor, but every registered socket still has its own descriptor. What epoll removes is the need for a thread or a poll scan per connection, not the descriptor. A service with 10,000 idle keep-alive connections still holds roughly 10,000 socket descriptors plus the epoll descriptor, so fd limits remain a capacity constraint even with an event-driven server.",
    followUps: [
      "What else consumes descriptors in an event-driven server?",
      "How does connection lifetime change the count?",
      "Would io_uring change the descriptor accounting?",
    ],
    redFlags: [
      "Says epoll eliminates per-connection descriptors.",
      "Confuses threads with descriptors.",
      "Ignores accepted sockets.",
    ],
    rubric: [
      "States that each socket has a descriptor.",
      "Explains what epoll saves.",
      "Connects lifetime and concurrency to the count.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The deployment spec sets RLIMIT_NOFILE explicitly and matches the expected peak concurrency.",
      "A process fd gauge and an accept-failure alert exist, with a slope condition on the gauge.",
      "The service has a documented way to list descriptor types without shelling into a dying process.",
      "Error paths that open sockets or files have cleanup tests.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm EMFILE and read the soft and hard limits from the process.",
      "Graph the count over time to distinguish a leak from a plateau.",
      "Restart or drain to restore new connections while preserving evidence.",
      "Do not raise the limit without recording the slope and the projected next crossing.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the close path and add a regression test for the failing branch.",
      "Set the limit from measured peak concurrency plus headroom.",
      "Verify accept failures and fd slope are quiet at peak.",
      "Document the restart and limit changes in the postmortem timeline.",
    ],
  },
];

const references = [
  {
    title: "open(2) — Linux manual page",
    url: "https://man7.org/linux/man-pages/man2/open.2.html",
    publisher: "Linux man-pages project",
    kind: "docs" as const,
    note: "Descriptor allocation, EMFILE, and close semantics.",
  },
  {
    title: "getrlimit(2) — Linux manual page",
    url: "https://man7.org/linux/man-pages/man2/getrlimit.2.html",
    publisher: "Linux man-pages project",
    kind: "docs" as const,
    note: "RLIMIT_NOFILE soft and hard limits.",
  },
  {
    title: "Amazon ECS task definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Container ulimits and task-level resource settings.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    fd: {
      model: fdModel,
      presets,
      instructions:
        "Start healthy, apply the leak, then raise the limit and compare the slopes. Watch open descriptors over time, not only the percentage.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Descriptor counts and limits are teaching values, not a runtime guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-linux-memory",
    "databases-connection-leak",
    "foundations-connection-pools",
  ],
};
