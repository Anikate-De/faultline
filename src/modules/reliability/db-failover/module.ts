import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITE_RPS = 2_400;
const WRITER_CAPACITY = 4_000;

const params: ParamSpec[] = [
  {
    id: "failoverActive",
    label: "Writer failover",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 starts a writer failover at the current time. 0 leaves the original writer in place.",
    format: "count",
  },
  {
    id: "dnsTtlS",
    label: "Database endpoint TTL",
    min: 1,
    max: 300,
    step: 1,
    value: 30,
    unit: " s",
    group: "DNS",
    help: "How long a resolver or client may keep the old writer address. A shorter TTL shortens the stale-address window.",
    format: "number",
  },
  {
    id: "retryPct",
    label: "Retry amplification",
    min: 0,
    max: 250,
    step: 10,
    value: 0,
    unit: "%",
    group: "Retries",
    help: "Extra write attempts per failed write. Every retry adds load to the new writer after the endpoint converges.",
    format: "percent",
  },
  {
    id: "jitterPct",
    label: "Reconnect jitter",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Reconnect",
    help: "Share of clients that spread their reconnect over the window. Zero sends every client at once.",
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

interface Computed {
  active: boolean;
  ttl: number;
  retry: number;
  jitter: number;
  elapsed: number;
  stale: boolean;
  converged: boolean;
  writerLoad: number;
  writerUtil: number;
  appErrors: number;
  retryAttempts: number;
  successfulWrites: number;
}

function compute(p: Params, elapsed: number): Computed {
  const active = num(p, "failoverActive", 0) >= 0.5;
  const ttl = clamp(Math.round(num(p, "dnsTtlS", 30)), 1, 300);
  const retry = clamp(num(p, "retryPct", 0), 0, 250) / 100;
  const jitter = clamp(num(p, "jitterPct", 80), 0, 100) / 100;
  const stale = active && elapsed < ttl;
  const converged = active && !stale;
  const burstRemaining = 1 - jitter * 0.7;
  const writerLoad = active ? (stale ? 0 : WRITE_RPS * (1 + retry * burstRemaining)) : WRITE_RPS;
  const writerUtil = writerLoad / WRITER_CAPACITY;
  const appErrors = !active
    ? 0
    : stale
      ? 100
      : clamp(((writerLoad - WRITER_CAPACITY) / writerLoad) * 100, 0, 100);
  const retryAttempts = active ? WRITE_RPS * retry * burstRemaining : 0;
  return {
    active,
    ttl,
    retry,
    jitter,
    elapsed,
    stale,
    converged,
    writerLoad,
    writerUtil,
    appErrors,
    retryAttempts,
    successfulWrites: active ? (stale ? 0 : WRITE_RPS * (1 - appErrors / 100)) : WRITE_RPS,
  };
}

function health(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.5))),
    );
  }
}

function buildFrame(p: Params, elapsed: number, seed: number): SimFrame {
  const c = compute(p, elapsed);
  const appHealth = health(c.appErrors, 1, 5);
  const writerHealth = c.active && !c.stale ? health(c.writerUtil * 100, 80, 100) : "ok";
  const dnsHealth: Health = c.active ? (c.stale ? (c.ttl >= 60 ? "crit" : "warn") : "ok") : "ok";
  const poolHealth: Health = c.active
    ? c.stale || c.retryAttempts >= 3_000
      ? "crit"
      : c.retryAttempts >= 1_500
        ? "warn"
        : "ok"
    : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.appErrors / 100),
        throughput: c.successfulWrites,
        sublabel: `${c.successfulWrites.toLocaleString("en-US")} writes/s served`,
        detail: `The application is failing ${c.appErrors.toFixed(0)}% of writes. Endpoint convergence is ${c.active ? (c.converged ? "complete" : "still pending") : "not needed"}.`,
        meta: { view: "flow" },
      },
      {
        id: "pool",
        label: "Connection pool",
        kind: "service",
        health: poolHealth,
        utilization: clamp(c.retryAttempts / 6_000),
        throughput: c.retryAttempts,
        sublabel: `${Math.round(c.retryAttempts).toLocaleString("en-US")} retries/s`,
        detail: `Pool rebuild is spread ${Math.round(c.jitter * 100)}% by jitter. Retry amplification is ${Math.round(c.retry * 100)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "dns",
        label: "Database endpoint",
        kind: "dns",
        health: dnsHealth,
        utilization: clamp(c.ttl / 300),
        throughput: c.active ? WRITE_RPS : 0,
        sublabel: c.active
          ? c.converged
            ? "new writer address"
            : `${c.ttl}s stale window`
          : "current writer",
        detail:
          "Clients can cache the old writer address for up to the TTL. Open connections to the old writer still fail until the pool replaces them.",
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Old writer",
        kind: "db",
        role: "primary",
        health: c.active ? "down" : "ok",
        utilization: c.active ? 1 : clamp(WRITE_RPS / WRITER_CAPACITY),
        throughput: c.active ? 0 : WRITE_RPS,
        sublabel: c.active ? "unavailable" : "serving writes",
        detail:
          "The failed writer is not the recovery target. Promotion happens on the standby, and the old address must stop being used.",
        meta: { view: "flow" },
      },
      {
        id: "new-writer",
        label: "New writer",
        kind: "db",
        role: "replica",
        health: c.active ? writerHealth : "ok",
        utilization: clamp(c.writerUtil),
        throughput: c.writerLoad,
        sublabel: `${Math.round(c.writerUtil * 100)}% utilized`,
        detail: `The promoted writer can serve ${WRITER_CAPACITY.toLocaleString("en-US")} writes/s. Current demand is ${Math.round(c.writerLoad).toLocaleString("en-US")} writes/s.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-pool", "app", "pool", clamp(1 - c.appErrors / 100), appHealth),
      edge("pool-dns", "pool", "dns", clamp(c.active ? 1 : 0.8), dnsHealth),
      edge("dns-primary", "dns", "primary", c.active ? 0 : 0.8, c.active ? "down" : "ok"),
      edge("dns-new", "dns", "new-writer", clamp(c.writerUtil), writerHealth),
    ],
    metrics: [
      metric("app-write-errors", "Application write errors", c.appErrors, "%", 1, 5, "percent"),
      metric(
        "writer-utilization",
        "New writer utilization",
        c.writerUtil * 100,
        "%",
        80,
        100,
        "percent",
      ),
      metric(
        "retry-attempts",
        "Retry attempts",
        c.retryAttempts,
        " attempts/s",
        1_500,
        3_000,
        "rps",
      ),
      metric(
        "successful-writes",
        "Successful writes",
        c.successfulWrites,
        " writes/s",
        undefined,
        undefined,
        "rps",
      ),
      metric(
        "stale-elapsed",
        "Seconds since writer loss",
        c.elapsed,
        " s",
        undefined,
        undefined,
        "number",
      ),
    ],
    events: [],
    series: {},
    flags: { seed, failoverElapsed: c.elapsed, failoverActive: c.active ? 1 : 0 },
    summary: `${c.appErrors.toFixed(0)}% of writes failing; new writer at ${Math.round(c.writerUtil * 100)}%; ${Math.round(c.retryAttempts).toLocaleString("en-US")} retries/s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "app-write-errors",
    metricId: "app-write-errors",
    warn: 1,
    crit: 5,
    title: "The application is still failing writes after the database failed over",
    cause:
      "The database promoted a new writer, but the application is still using the old address, an open connection to the old writer, or a retry policy that multiplies the first failure.",
    fix: "Separate the recovery into phases: stop new work, drain the pool, resolve the new endpoint, reconnect with jitter, then restore traffic. Retry with a budget and backoff, not immediately and not without a cap.",
    checkFirst: [
      "Confirm the promoted writer is healthy and accepting writes.",
      "Compare the application endpoint with the new writer address.",
      "Check whether errors are connection failures or capacity rejections.",
    ],
  },
  {
    id: "writer-utilization",
    metricId: "writer-utilization",
    warn: 80,
    crit: 100,
    title: "The new writer is saturated by reconnect and retry load",
    cause:
      "The failover moved every client at once, and retries added to the normal write rate. The new writer is healthy but has less headroom than the old one.",
    fix: "Reduce the offered load before adding capacity: disable retries for non-idempotent work, jitter reconnects, and apply a connection budget. Scale the writer only after the retry volume is bounded.",
    checkFirst: [
      "Compare offered writes with the new writer capacity.",
      "Check whether retries or duplicate clients dominate the load.",
      "Check whether the connection pool is still recycling stale connections.",
    ],
  },
  {
    id: "retry-attempts",
    metricId: "retry-attempts",
    warn: 1_500,
    crit: 3_000,
    title: "Retries are amplifying the failover",
    cause:
      "Each failed write produced more than one new attempt. The retries arrive while the pool is reconnecting, so they compete with the recovery itself.",
    fix: "Cap retries per request, add jitter and backoff, and fail fast when the writer is known to be unavailable. Retry only idempotent work, and use a shared budget so one client cannot consume the recovery capacity.",
    checkFirst: [
      "Check the retry count per failed write.",
      "Check whether retries have backoff and jitter.",
      "Check whether the retry volume falls when the error rate falls.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-failover-recovery",
  title: "Predict what keeps the app down after promotion",
  simId: "db-failover",
  question:
    "The old writer failed, the standby was promoted, and the new writer is healthy. The application is still failing most writes two minutes later. What should you check first?",
  prediction: {
    options: [
      { id: "replication", label: "Replication lag on the new writer" },
      {
        id: "reconnect",
        label: "Stale endpoint resolution, pool rebuild, and retry amplification",
      },
      { id: "capacity", label: "The old writer's disk throughput" },
      { id: "dns-record", label: "The public DNS record for the customer website" },
    ],
    correctOptionId: "reconnect",
    explanation:
      "Promotion is a database event. Application recovery is a separate sequence: the endpoint must converge, pooled connections to the old writer must be discarded, and retries must be bounded. The database can be healthy while every one of those application steps is still failing.",
  },
  setup: defaults({
    failoverActive: 1,
    dnsTtlS: 10,
    retryPct: 150,
    jitterPct: 0,
  }),
  runFor: 30,
  observe: [
    "The endpoint converges after 10 simulated seconds, but application write errors stay above 30%.",
    "The new writer reaches 150% utilization because retries add to the normal write rate.",
    "Retry attempts reach 3,600 per second and cross the critical threshold.",
    "The application error rate does not fall when the database reports healthy.",
  ],
  explain:
    "The promoted writer was never the bottleneck at first. The stale endpoint caused the initial failures; the unbounded retries then kept the new writer over capacity after convergence. A failover runbook must cover the application sequence, not just the database promotion.",
  fix: defaults({
    failoverActive: 1,
    dnsTtlS: 5,
    retryPct: 0,
    jitterPct: 90,
  }),
  debrief:
    "With a short endpoint TTL, no retry amplification, and jittered reconnects, the same failover completes with the writer at 60% utilization. Recovery time is dominated by connection handling, not by the promotion.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A database failover is two recoveries that share a timeline. The database promotes a standby and begins accepting writes at a new address. The application then has to stop using the old writer, resolve the new address, discard stale connections, and reconnect without multiplying the load. The database can finish first and still leave the product down.",
  },
  {
    type: "p",
    text: "The gap is connection handling. A managed writer endpoint usually changes its DNS (Domain Name System) answer, but clients cache that answer for the record time to live (TTL). Open TCP (Transmission Control Protocol) connections do not follow DNS at all; they fail when the old writer disappears. Every process then reconnects at the same moment, and every failed write may be retried. The result is a reconnect storm against a writer that has less headroom than the old one.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The failover sits between the database service and the application's connection pool. The database controls promotion, replication, and the writer endpoint. The application controls pool lifetime, connection validation, retry policy, and traffic ramping. A runbook that only covers promotion leaves the larger half of the recovery unmanaged.",
  },
  {
    type: "table",
    headers: ["Phase", "Database state", "Application state", "Signal to watch"],
    rows: [
      [
        "Detection",
        "Old writer failing",
        "Writes time out or reset",
        "Error rate and connection resets",
      ],
      [
        "Promotion",
        "Standby becomes writer",
        "Still on old address or connection",
        "New writer accepting writes",
      ],
      [
        "Endpoint convergence",
        "New writer healthy",
        "DNS cache still stale",
        "Endpoint TTL and resolve errors",
      ],
      ["Pool rebuild", "New writer healthy", "Connections reconnecting", "Reconnects per second"],
      [
        "Retry recovery",
        "New writer loaded",
        "Retries amplify demand",
        "Retry attempts and utilization",
      ],
      ["Steady state", "New writer stable", "Traffic restored in steps", "Error rate and headroom"],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative: 2,400 writes per second, a 4,000 writes-per-second writer, and a 30-second endpoint TTL. The structure is the lesson. Recovery time is the sum of detection, promotion, endpoint convergence, pool rebuild, and retry drain, and the last three are application concerns.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Application write errors: the customer-visible result, which can stay high after promotion.",
      "New writer utilization: whether reconnect and retry load exceed the new capacity.",
      "Retry attempts per second: amplification created by the application, not the database.",
      "Successful writes per second: the actual recovered throughput.",
      "Endpoint and pool health: whether the application has moved to the new writer.",
    ],
  },
  {
    type: "compare",
    leftTitle: "Promotion-only runbook",
    rightTitle: "End-to-end failover runbook",
    rows: [
      { label: "Owner", left: "Database team", right: "Database and application teams" },
      { label: "Endpoint", left: "Assume DNS updates", right: "Verify resolve and TTL behavior" },
      {
        label: "Connections",
        left: "Wait for pools to recover",
        right: "Drain and rebuild with jitter",
      },
      { label: "Retries", left: "Client default", right: "Bounded, idempotent, backoff" },
      { label: "Traffic", left: "Return all at once", right: "Ramp against error and headroom" },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Writer failure. Watch application errors rise while the new writer reports zero utilization: the database is not the current bottleneck. Apply Slow DNS to hold that state, then apply Recovery to see the application sequence complete. Run the experiment before revealing the answer.",
  },
  { type: "sim", simId: "db-failover" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the experiment, the writer failed and the standby was promoted. For the first ten simulated seconds the application could not use the new writer because its endpoint and pool still pointed at the old one. Then the endpoint converged, but 150% retry amplification sent 6,000 writes per second at a 4,000 writes-per-second writer. The database was healthy and the application was still failing.",
  },
  {
    type: "p",
    text: "Removing retry amplification, shortening the endpoint TTL, and spreading reconnects brought the same failover to 60% utilization with no write errors. The promotion did not get faster. The application stopped adding work to it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database metrics show a healthy new writer while application write errors remain elevated.",
      "Connection resets and pool checkout failures appear before application error rate peaks.",
      "DNS resolve latency or stale answers persist for the record TTL after promotion.",
      "Retry volume rises independently of the original write rate.",
      "The new writer shows a sharp utilization step when the first large client reconnects.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the new writer is healthy, then compare the application endpoint with the new writer address. Check whether connections are failing to resolve or failing to authenticate, and whether retries are multiplying the offered load. Do not add writer capacity until you know whether the demand is real traffic or retry amplification.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Detect the writer failure and stop issuing new writes to the old address.",
      "Confirm promotion and the new writer's capacity before moving traffic.",
      "Drain the connection pool and discard connections to the old writer.",
      "Resolve the new endpoint and reconnect with jitter and a connection budget.",
      "Disable or bound retries for non-idempotent writes; keep backoff and a retry budget for the rest.",
      "Ramp application traffic against error rate and writer headroom, not against a clock.",
      "Verify successful writes, not just database health, before declaring recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short endpoint TTL speeds convergence but increases DNS query volume and reduces the benefit of caching.",
      "Draining the pool avoids stale connections but causes a short, deliberate error window.",
      "Aggressive retries improve success during a brief blip but turn a failover into a capacity incident.",
      "Ramping traffic slowly protects the new writer but prolongs partial availability for customers.",
      "Adding writer capacity can hide retry amplification and makes the next failover more expensive.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "failover-sequence",
    question: "The database has failed over. Walk me through the application recovery sequence.",
    difficulty: 3,
    hints: [
      "Promotion is not the end of the failover.",
      "Think about endpoints, open connections, retries, and traffic.",
    ],
    answer:
      "First I confirm the new writer is healthy and accepting writes, then I check that the application resolves the new endpoint and is not holding connections to the old writer. I drain the pool, reconnect with jitter and a connection budget, and keep retries bounded. Once errors fall, I ramp traffic in steps and watch writer utilization and error rate. I declare recovery only when successful writes are stable, not when the database reports healthy.",
    followUps: [
      "What would you measure at each phase?",
      "How do you avoid a thundering herd during reconnect?",
      "When would you fail back?",
    ],
    redFlags: [
      "Stops at database promotion.",
      "Lets every client reconnect at once.",
      "Adds capacity before checking retry volume.",
    ],
    rubric: [
      "Separates database and application recovery.",
      "Covers endpoint and pool behavior.",
      "Bounds retries and jitter.",
      "Ramps traffic against signals.",
    ],
  },
  {
    id: "reconnect-storm",
    question:
      "Every application instance reconnects at the same moment and the new writer saturates. What do you change?",
    difficulty: 3,
    hints: [
      "The new writer may have less headroom than the old one.",
      "Spread the reconnect and separate retries from fresh traffic.",
    ],
    answer:
      "I would stop the synchronized reconnect, add jitter to the pool rebuild, and cap the number of new connections per second. I would also separate retries from fresh traffic so the writer sees the real demand, and disable retries for non-idempotent writes. If the writer is still over capacity after that, I would shed low-value writes or scale the writer, but only after the retry volume is bounded.",
    followUps: [
      "How do you choose the reconnect rate?",
      "What is a retry budget?",
      "Which writes can safely retry?",
    ],
    redFlags: [
      "Restarts every application at once.",
      "Raises the connection limit on the writer without a plan.",
      "Retries all writes to improve success rate.",
    ],
    rubric: [
      "Spreads reconnect.",
      "Caps connection rate.",
      "Separates retries from fresh traffic.",
      "Bounds retries by idempotency.",
    ],
  },
  {
    id: "reduce-mttr",
    question: "How would you reduce failover recovery time from ten minutes to under two?",
    difficulty: 3,
    hints: ["Measure each phase separately.", "The slowest phase is often application-side."],
    answer:
      "I would instrument detection, promotion, endpoint convergence, pool rebuild, retry drain, and traffic ramp separately. Then I would shorten the endpoint TTL within its operational limits, make the pool validate and recycle connections quickly, add jitter and a reconnect budget, and rehearse the application sequence. I would also pre-warm capacity or keep the standby at a size that matches the real post-failover load. The target is a measured phase budget, not a single end-to-end number.",
    followUps: [
      "Which phase would you optimize first?",
      "How do you test the runbook without a real outage?",
      "What is the risk of a very short TTL?",
    ],
    redFlags: [
      "Only measures database promotion.",
      "Sets a target without phase data.",
      "Skips rehearsal because the database is managed.",
    ],
    rubric: [
      "Measures phases separately.",
      "Addresses endpoint and pool.",
      "Uses rehearsal.",
      "Sizes standby capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The writer endpoint TTL and client cache behavior are documented.",
      "Pools validate connections on checkout and recycle stale ones.",
      "Retries are bounded, jittered, and limited to idempotent work.",
      "The standby writer is sized for post-failover demand, including reconnect load.",
      "A failover runbook covers application recovery, not only database promotion.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm promotion and new writer health before moving traffic.",
      "Drain the pool and discard connections to the old writer.",
      "Reconnect with jitter and a connection budget.",
      "Keep retries bounded and separate from fresh traffic.",
      "Ramp traffic against error rate and writer headroom.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare time spent in detection, promotion, convergence, pool rebuild, and ramp.",
      "Verify that successful writes, not just database health, returned to normal.",
      "Check for duplicate writes created by retries.",
      "Rehearse the same failover with production-like connection counts.",
    ],
  },
];

const references = [
  {
    title: "Failover process for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How Multi-AZ promotion changes the writer and what the application must handle.",
  },
  {
    title: "Timeouts, retries, and backoff with jitter",
    url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Why retries amplify failures and how jitter and budgets limit the load.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Coordinating recovery and communicating state during an active incident.",
  },
];

export const dbFailoverModel: SimModel = {
  id: "reliability-db-failover",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const active = num(p, "failoverActive", 0) >= 0.5;
    const wasActive = frame.flags.failoverActive === 1;
    const previous = Math.max(0, Number(frame.flags.failoverElapsed ?? 0));
    const elapsed = !active ? 0 : wasActive ? previous + Math.max(0, dt) : Math.max(0, dt);
    const c = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, elapsed, seed);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      failoverElapsed: elapsed,
      failoverActive: active ? 1 : 0,
    };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);

    if (active && !wasActive) {
      pushEvent(next, {
        id: "db-failover-start",
        at: frame.t,
        severity: "crit",
        title: "Writer failure detected",
        detail: `${WRITE_RPS.toLocaleString("en-US")} writes/s were going to the old writer. Promotion is complete, but the application endpoint may still be cached for ${c.ttl}s.`,
        nodeId: "app",
        metricId: "app-write-errors",
      });
    }
    if (active && c.converged && frame.flags.dbFailoverConverged !== 1) {
      pushEvent(next, {
        id: "db-failover-converged",
        at: frame.t,
        severity: "info",
        title: "Application endpoint points at the new writer",
        detail: `The stale-address window ended after ${c.ttl}s. Connections still need to be rebuilt, and retries can still overload the writer.`,
        nodeId: "dns",
        metricId: "writer-utilization",
      });
      next.flags.dbFailoverConverged = 1;
    }
    if (!active) next.flags.dbFailoverConverged = 0;
    if (c.retryAttempts >= 3_000 && frame.flags.dbFailoverStorm !== 1) {
      pushEvent(next, {
        id: "db-failover-retry-storm",
        at: frame.t,
        severity: "crit",
        title: "Retry storm saturates the new writer",
        detail: `Retries add ${Math.round(c.retryAttempts).toLocaleString("en-US")} attempts/s to ${WRITE_RPS.toLocaleString("en-US")} writes/s. The new writer is at ${Math.round(c.writerUtil * 100)}% utilization.`,
        nodeId: "pool",
        metricId: "retry-attempts",
      });
      next.flags.dbFailoverStorm = 1;
    }
    if (c.retryAttempts < 3_000) next.flags.dbFailoverStorm = 0;
    if (active && c.converged && c.appErrors === 0 && frame.flags.dbFailoverRecovered !== 1) {
      pushEvent(next, {
        id: "db-failover-recovered",
        at: frame.t,
        severity: "info",
        title: "Application writes recovered",
        detail: `Successful writes are back at ${Math.round(c.successfulWrites).toLocaleString("en-US")} per second with the new writer at ${Math.round(c.writerUtil * 100)}% utilization.`,
        nodeId: "app",
        metricId: "successful-writes",
      });
      next.flags.dbFailoverRecovered = 1;
    }
    if (!active || c.appErrors > 0) next.flags.dbFailoverRecovered = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, Math.max(0, Number(frame.flags.failoverElapsed ?? 0)));
    const items: string[] = [];
    items.push(
      c.active
        ? `The old writer failed ${c.elapsed.toFixed(0)}s ago. The application is ${c.stale ? `still inside the ${c.ttl}s endpoint window` : "pointing at the new writer"} and is failing ${c.appErrors.toFixed(0)}% of writes.`
        : `The writer is healthy and serving ${WRITE_RPS.toLocaleString("en-US")} writes/s at ${Math.round(c.writerUtil * 100)}% utilization.`,
    );
    items.push(
      c.active
        ? `The new writer is at ${Math.round(c.writerUtil * 100)}% utilization. Demand is ${Math.round(c.writerLoad).toLocaleString("en-US")} writes/s against ${WRITER_CAPACITY.toLocaleString("en-US")} writes/s of capacity.`
        : "No failover is active.",
    );
    items.push(
      `Retry amplification is ${Math.round(c.retry * 100)}%, producing ${Math.round(c.retryAttempts).toLocaleString("en-US")} attempts/s. Jitter spreads ${Math.round(c.jitter * 100)}% of the reconnect.`,
    );
    items.push(
      "Promotion is a database event. Endpoint convergence, pool rebuild, and retry drain are application work, and they often dominate recovery time.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Stale endpoint", tone: "warn" },
    { label: "Failing app", tone: "crit" },
    { label: "Old writer down", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "The original writer serves 2,400 writes/s at 60% of capacity. No failover is active.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Reconnect wave",
    description:
      "Failover completes quickly, but 100% retry amplification and modest jitter push the new writer to a warning.",
    tone: "warn",
    params: defaults({ failoverActive: 1, dnsTtlS: 1, retryPct: 100, jitterPct: 70 }),
    elapsed: 5,
  },
  {
    id: "failure",
    label: "Writer failure",
    description:
      "The writer fails, the endpoint is cached for 20 seconds, and every failed write is retried 1.5 times.",
    tone: "crit",
    params: defaults({ failoverActive: 1, dnsTtlS: 20, retryPct: 150, jitterPct: 0 }),
    elapsed: 30,
  },
  {
    id: "slow-dns",
    label: "Slow DNS",
    description:
      "The new writer is healthy and idle, but a 90-second endpoint TTL keeps every client on the old address.",
    tone: "crit",
    params: defaults({ failoverActive: 1, dnsTtlS: 90, retryPct: 0, jitterPct: 100 }),
  },
  {
    id: "recovery",
    label: "Recovered",
    description:
      "The failover is over: the writer is healthy, retries are off, and the pool reconnects with jitter. The writer runs at 60%.",
    tone: "ok",
    params: defaults({ failoverActive: 0, dnsTtlS: 5, retryPct: 0, jitterPct: 90 }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "db-failover": {
      model: dbFailoverModel,
      presets,
      instructions:
        "Start Healthy, apply Writer failure, and watch application errors while the new writer is still idle. Apply Slow DNS to see the database healthy before the application. Then apply Recovery and compare the writer utilization and retry volume.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline", "replication"],
      note: "Illustrative model. Write rate, writer capacity, TTL, and retry values are teaching examples, not vendor limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-failover-dns",
    "reliability-retry-storms",
    "reliability-dependency-failure",
    "reliability-customer-comms",
  ],
};
