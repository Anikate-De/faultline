import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_WRITE_MS = 15;
const FORWARD_OVERHEAD_MS = 80;
const WRITE_TIMEOUT_MS = 650;
const WRITE_RATE = 400;
const PRIMARY_CAPACITY = 2_400;

const params = [
  {
    id: "forwarding",
    label: "Write forwarding",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "1 connects the app to the secondary cluster's reader endpoint with global write forwarding. 0 sends writes to the primary cluster endpoint.",
    format: "count" as const,
  },
  {
    id: "consistency",
    label: "Session consistency",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Consistency",
    help: "1 is the session mode: a read after a forwarded write waits for the change to replicate. 0 is eventual: the read does not wait and may see older data.",
    format: "count" as const,
  },
  {
    id: "rttMs",
    label: "Cross-Region round trip",
    min: 20,
    max: 600,
    step: 10,
    value: 70,
    unit: " ms",
    group: "Network",
    help: "Round-trip time between the secondary Region and the primary Region. A forwarded write still pays this boundary once.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  forwarding: boolean;
  session: boolean;
  rtt: number;
  writeP99: number;
  timeoutShare: number;
  timedOut: number;
  readWait: number;
  staleGap: number;
  primaryUtil: number;
  appHealth: Health;
  secondaryHealth: Health;
}

function compute(p: Params): Computed {
  const forwarding = num(p, "forwarding", 1) >= 0.5;
  const session = num(p, "consistency", 1) >= 0.5;
  const rtt = clamp(num(p, "rttMs", 70), 20, 600);
  const writeP99 = BASE_WRITE_MS + rtt + (forwarding ? FORWARD_OVERHEAD_MS : 0);
  const timeoutShare = clamp((writeP99 - WRITE_TIMEOUT_MS) / writeP99, 0, 1);
  const timedOut = WRITE_RATE * timeoutShare;
  const readWait = forwarding && session ? BASE_WRITE_MS + rtt : 0;
  const staleGap = forwarding && !session ? rtt : 0;
  const primaryUtil = clamp(WRITE_RATE / PRIMARY_CAPACITY);
  const appHealth: Health =
    timedOut >= 20 ? "crit" : timedOut > 0 ? "warn" : staleGap >= 600 ? "warn" : "ok";
  const secondaryHealth: Health = !forwarding
    ? "ok"
    : writeP99 >= WRITE_TIMEOUT_MS
      ? "crit"
      : writeP99 >= 450
        ? "warn"
        : "ok";
  return {
    forwarding,
    session,
    rtt,
    writeP99,
    timeoutShare,
    timedOut,
    readWait,
    staleGap,
    primaryUtil,
    appHealth,
    secondaryHealth,
  };
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

function formatRate(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["write-p99", values.writeP99, 3],
    ["write-timeouts", values.timedOut, 0.4],
    ["read-wait", values.readWait, 2],
    ["stale-gap", values.staleGap, 2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      value <= 0 ? 0 : Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, flags: SimFrame["flags"] = {}): SimFrame {
  const values = compute(p);
  const path = values.forwarding ? "secondary forwarding path" : "direct primary path";
  const pathLabel = values.forwarding ? "Forwarded" : "Direct";
  const scopeLabel = values.forwarding ? "forwarded" : "direct";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "App · secondary Region",
        kind: "client",
        health: values.appHealth,
        utilization: clamp(values.timedOut / 100),
        sublabel: `${formatRate(WRITE_RATE)} writes/s · ${path}`,
        detail: `The app writes through the ${path}. A timeout means the client stopped waiting; it does not prove the primary rolled the transaction back.`,
        meta: { view: "flow" },
      },
      {
        id: "secondary",
        label: "Secondary cluster · local endpoint",
        kind: "db",
        role: "replica",
        health: values.secondaryHealth,
        utilization: values.forwarding ? clamp(values.writeP99 / 1_000) : 0,
        sublabel: values.forwarding ? `forwarding on · p99 ${formatMs(values.writeP99)}` : "forwarding off · reads only",
        detail: values.forwarding
          ? "The secondary accepts the write, forwards it to the primary, and returns the result. Its local data becomes current only after replication catches up."
          : "The app bypasses the secondary for writes and connects to the primary writer endpoint.",
        meta: { view: "flow", lag: values.staleGap / 1_000 },
      },
      {
        id: "primary",
        label: "Primary writer · source of truth",
        kind: "db",
        role: "primary",
        health: "ok",
        utilization: values.primaryUtil,
        throughput: WRITE_RATE,
        capacity: PRIMARY_CAPACITY,
        sublabel: `${formatRate(WRITE_RATE)} writes/s · single writer`,
        detail: "Every forwarded write commits here. Forwarding changes the path, not the writer or the transaction boundary.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-secondary", "app", "secondary", values.forwarding ? 1 : 0.35, values.appHealth, values.forwarding ? "local hop" : "reads"),
      edge("secondary-primary", "secondary", "primary", values.forwarding ? 1 : 0, values.secondaryHealth, "forwarded write"),
      edge("app-primary", "app", "primary", values.forwarding ? 0 : 1, "ok", "direct write"),
    ],
    metrics: [
      metric("write-p99", `${pathLabel} write p99`, values.writeP99, "ms", 450, 650, "ms"),
      metric("write-timeouts", `${pathLabel} write timeouts (modeled)`, values.timedOut, " writes/s", 1, 20, "rps"),
      metric("read-wait", `Read-after-write wait (session, ${scopeLabel})`, values.readWait, "ms", 250, 600, "ms"),
      metric("stale-gap", `Eventual read gap (${scopeLabel})`, values.staleGap, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { ...flags, seed },
    summary: `${values.forwarding ? "Forwarded" : "Direct"} writes: p99 ${formatMs(values.writeP99)}; ${formatRate(
      values.timedOut,
    )} modeled timeouts/s; read wait ${formatMs(values.readWait)}; eventual gap ${formatMs(values.staleGap)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "write-p99",
    metricId: "write-p99",
    warn: 450,
    crit: 650,
    title: "Write latency reaches the application timeout",
    cause:
      "A write still crosses the Region once, and forwarding adds a hop and session handling on the secondary. When the round trip rises, that extra hop can push p99 past the client's write timeout even though the primary can finish the commit.",
    fix:
      "Send writes to the primary writer endpoint when latency is the constraint, move the workload closer, or keep the forwarded path only for writes that can wait. Raising the timeout is safe only when retries are idempotent.",
    checkFirst: [
      "Compare the write p99 with the application statement or transaction timeout.",
      "Compare the same workload with forwarding off to isolate the extra hop.",
      "Check whether timeouts are followed by duplicate writes, which means the commit succeeded after the client gave up.",
    ],
  },
  {
    id: "write-timeouts",
    metricId: "write-timeouts",
    warn: 1,
    crit: 20,
    title: "Forwarded writes are timing out after commit",
    cause:
      "The client stops waiting before the forwarding path returns. The primary may still commit the statement, so the outcome is unknown to the application. A blind retry can apply the write twice.",
    fix:
      "Make write retries idempotent with a request key, record the outcome on the primary where possible, and choose a path whose p99 fits inside the timeout. Do not treat a timeout as a rollback.",
    checkFirst: [
      "Check for duplicate rows or duplicate side effects after the timeout window.",
      "Check the primary's commit rate and the secondary's forwarding latency together.",
      "Check whether the driver retries automatically and whether the retry reuses the same idempotency key.",
    ],
  },
  {
    id: "read-wait",
    metricId: "read-wait",
    warn: 250,
    crit: 600,
    title: "Session consistency is adding a cross-Region read wait",
    cause:
      "In session consistency mode, a read after a forwarded write waits until the change is visible in the secondary Region. The wait is bounded by replication and network time, not by the write's local execution.",
    fix:
      "Keep session consistency for reads that must see the user's own write, and use eventual reads elsewhere. If the wait is too large, read from the primary for that request or reduce the distance between Regions.",
    checkFirst: [
      "Check whether the slow request is a read immediately after a write in the same session.",
      "Check ForwardingReplicaReadWaitLatency on the secondary cluster.",
      "Check whether all reads are using session consistency when only some need it.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const writeForwardingModel: SimModel = {
  id: "databases-write-forwarding",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.flags);
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];

    if (values.timedOut > 0 && frame.flags.timeoutLogged !== 1) {
      pushEvent(next, {
        id: "forwarded-write-timeout",
        at: frame.t,
        severity: values.timedOut >= 20 ? "crit" : "warn",
        title: "Forwarded write exceeded the application timeout",
        detail: `p99 is ${formatMs(values.writeP99)} against a ${WRITE_TIMEOUT_MS}ms timeout. About ${formatRate(
          values.timedOut,
        )} writes/s stop waiting each second; the primary can still commit them.`,
        nodeId: "secondary",
        metricId: "write-timeouts",
      });
    }
    if (values.staleGap > 0 && frame.flags.staleLogged !== 1) {
      pushEvent(next, {
        id: "forwarded-read-stale",
        at: frame.t,
        severity: "warn",
        title: "A read after the forwarded write can see older data",
        detail: `Eventual consistency does not wait. The secondary can be about ${formatMs(
          values.staleGap,
        )} behind the forwarded commit, so the next local read may return the previous value.`,
        nodeId: "secondary",
        metricId: "stale-gap",
      });
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      timeoutLogged: values.timedOut > 0 ? 1 : 0,
      staleLogged: values.staleGap > 0 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The write path is ${values.forwarding ? "app to secondary to primary" : "app directly to primary"}. The primary is the only writer in both cases.`,
      `The modeled p99 is ${formatMs(values.writeP99)}. Forwarding adds ${FORWARD_OVERHEAD_MS}ms of hop and session overhead on top of the same ${formatMs(
        values.rtt,
      )} cross-Region round trip.`,
    ];
    if (values.timedOut > 0) {
      items.push(
        `About ${formatRate(
          values.timedOut,
        )} writes/s exceed the ${WRITE_TIMEOUT_MS}ms timeout. Those statements may still commit, so retries must be idempotent.`,
      );
    } else {
      items.push(`No writes exceed the ${WRITE_TIMEOUT_MS}ms timeout in this state.`);
    }
    if (values.forwarding && values.session) {
      items.push(
        `Session consistency makes a read after the write wait about ${formatMs(
          values.readWait,
        )}, so it returns the new value instead of a stale one.`,
      );
    } else if (values.forwarding) {
      items.push(
        `Eventual consistency returns immediately, but a read after the write can be about ${formatMs(
          values.staleGap,
        )} behind.`,
      );
    } else {
      items.push("Direct writes avoid the forwarding hop, but the app must still route read-after-write reads correctly.");
    }
    items.push(
      `The timeout share is modeled as (p99 minus the write timeout) divided by p99; it is not a measured error rate.`,
    );
    items.push("A timeout is not a rollback. The database may have committed before the client stopped waiting.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Forwarding is on with session consistency and a 70ms cross-Region round trip. Writes fit the 650ms timeout.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak latency",
    description: "The round trip rises to 380ms. Writes still fit, but forwarded p99 and the session read wait are both in warning.",
    tone: "warn",
    params: defaults({ rttMs: 380 }),
  },
  {
    id: "failure",
    label: "Forwarded write timeout",
    description: "At 600ms round trip, forwarded p99 is 695ms against a 650ms timeout. About 26 writes/s time out after a possible commit.",
    tone: "crit",
    params: defaults({ forwarding: 1, consistency: 0, rttMs: 600 }),
  },
  {
    id: "recovery",
    label: "Direct primary writes",
    description: "The app writes to the primary endpoint. The forwarding hop is gone, p99 falls to 415ms, and no write times out.",
    tone: "ok",
    params: defaults({ forwarding: 0, consistency: 0, rttMs: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-forwarded-timeout",
  title: "Predict the forwarded write timeout",
  simId: "write-forwarding",
  question:
    "The cross-Region round trip is 600ms, the application write timeout is 650ms, and write forwarding is on. What happens to a forwarded write?",
  prediction: {
    options: [
      { id: "all-fit", label: "All writes fit; forwarding keeps the write local and returns in about 15ms." },
      {
        id: "timeout-after-commit",
        label: "The p99 is about 695ms, so a small share time out; the primary can still commit those writes.",
      },
      {
        id: "two-trips",
        label: "The p99 is about 1,215ms because the write crosses the Region twice.",
      },
      {
        id: "primary-rejects",
        label: "The primary rejects the write before commit because the timeout is enforced in the database.",
      },
    ],
    correctOptionId: "timeout-after-commit",
    explanation:
      "The model adds the 15ms base, the 600ms cross-Region round trip, and an 80ms forwarding hop: about 695ms. That is above the 650ms application timeout, so some statements stop waiting before the result returns. The primary may already have committed. The write crosses the Region once, not twice.",
  },
  setup: defaults({ forwarding: 1, consistency: 0, rttMs: 600 }),
  runFor: 20,
  observe: [
    "Write p99 is about 695ms and crosses the critical threshold.",
    "About 26 writes per second exceed the application timeout.",
    "The eventual read gap is 600ms, so a read immediately after the write can return the old value.",
    "The read-after-write wait is zero because eventual consistency does not wait.",
    "The primary writer is lightly loaded. The failure is latency and outcome ambiguity, not writer capacity.",
  ],
  explain:
    "Write forwarding preserves a single writer: the app connects to the secondary, but the primary performs the write and commits it. The forwarded path still pays the cross-Region round trip and adds a hop. When the client times out, it does not know whether the commit happened. A retry can duplicate the write unless the application uses an idempotency key. Eventual reads do not wait, so they can also show the previous value.",
  fix: defaults({ forwarding: 0, consistency: 0, rttMs: 600 }),
  debrief:
    "Direct primary writes remove the forwarding hop and bring p99 to about 615ms, below the 650ms timeout. That is more margin, not comfort: the cross-Region round trip is still the dominant cost. Keep retries idempotent, and reserve session consistency for reads that must see the user's own write.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Aurora global database has one primary cluster and up to ten read-only secondary clusters in other Regions. Normally, an application in a secondary Region can read locally but must connect to the primary Region to write. Write forwarding changes that endpoint choice: a client connects to the secondary cluster's reader endpoint, sends a write statement, and Aurora forwards it to the primary cluster. The primary executes and commits the statement, then replicas receive the change through the global replication path.",
  },
  {
    type: "p",
    text: "The primary remains the only writer. Forwarding is not a local write and not a second writer. It removes the need to build your own cross-Region write proxy or keep a separate primary endpoint in every application. The cost is latency: the statement travels to the primary and the response travels back, plus the forwarding hop and session handling on the secondary. Aurora documents that write forwarding adds latency for exactly this reason.",
  },
  {
    type: "p",
    text: "Consistency is a separate decision. A forwarded write can be committed on the primary before the secondary Region has replayed it. With eventual consistency, a read immediately after the write does not wait and may return the previous value. With session consistency, that read waits until the forwarded change is visible; Aurora PostgreSQL uses apg_write_forward.consistency_mode with SESSION by default, and Aurora MySQL requires the session to set aurora_replica_read_consistency. The wait buys read-after-write correctness at the cost of response time.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application, secondary cluster reader endpoint, forwarding connection, primary writer, commit, replication back to the secondary. Reads that do not need freshness can stay on the secondary. Writes that cannot be forwarded, such as data definition language (DDL) statements in Aurora PostgreSQL, must go to the primary. Always enable forwarding deliberately: it is off by default on a secondary cluster, and in Aurora MySQL a session also needs the consistency setting before forwarding is used.",
  },
  {
    type: "compare",
    leftTitle: "Forwarded write",
    rightTitle: "Direct to primary",
    rows: [
      { label: "Client endpoint", left: "Secondary cluster reader endpoint", right: "Primary cluster writer endpoint" },
      { label: "Who commits", left: "Primary writer", right: "Primary writer" },
      { label: "Extra hop", left: "Secondary forwarding and response path", right: "None beyond the client-to-primary path" },
      { label: "Read-after-write", left: "Consistency mode can wait for replication", right: "Application must route the read" },
      { label: "Operational shape", left: "One local endpoint per Region", right: "Every Region needs the primary endpoint" },
    ],
  },
  {
    type: "p",
    text: "The secondary is still a read-only cluster. Forwarding accepts a write on its behalf, but it does not make the secondary writable for local sessions that bypass forwarding. A statement that is not supported by forwarding fails rather than silently writing locally.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Forwarded write p99: the full client-visible latency, including the cross-Region round trip and the forwarding hop.",
      "Write timeouts: statements that exceeded the application timeout. A timeout does not prove the commit failed.",
      "Read-after-write wait: the extra time a session-consistent read spends waiting for replication.",
      "Eventual read gap: how far behind a read can be when the session does not wait.",
      "The primary writer's utilization, which stays low because forwarding changes the path, not the write rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Forwarded write timeout. Read the p99 and timeout count before moving the round-trip slider. Switch session consistency on to see the stale gap turn into a read wait. Then turn forwarding off to compare the same round trip on the direct primary path. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Latency values, the 650ms timeout, and the 400 writes per second workload are illustrative teaching values, not Aurora limits or guarantees. The primary capacity is a model input used only to show that the writer is not the bottleneck.",
  },
  { type: "sim", simId: "write-forwarding" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At a 600ms cross-Region round trip, a forwarded write took about 695ms: 15ms of base work, the 600ms boundary, and an 80ms forwarding hop. The application timeout was 650ms, so about 26 of 400 writes per second stopped waiting. The primary could still commit them. The client saw an error, but the database saw a transaction.",
  },
  {
    type: "p",
    text: "With eventual consistency, a read immediately after the write could be 600ms behind, so it returned the old value. With session consistency, that read waited about 615ms for the change to become visible. Neither mode creates a second writer; both change what the client waits for.",
  },
  {
    type: "p",
    text: "Turning forwarding off removed the extra hop. The same 600ms boundary produced a p99 of about 615ms, under the timeout. That is a real improvement, but it is still one cross-Region round trip. The application also had to take responsibility for routing read-after-write reads.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Aurora MySQL: ForwardingReplicaDMLLatency on each secondary reader, ForwardingReplicaOpenSessions, and ForwardingWriterDMLLatency on the primary. Rejected forwarded queries show up as AuroraDMLRejectedWriterFull in Aurora MySQL v3; v2 uses AuroraDMLRejectedMasterFull.",
      "Aurora PostgreSQL: AuroraForwardingReplicaDMLLatency, AuroraForwardingReplicaReadWaitLatency, AuroraForwardingReplicaErrorSessionsLimit, and AuroraForwardingWriterOpenSessions.",
      "Application: statement timeouts, retries, duplicate idempotency keys, and 5xx responses that begin at the same time as a latency increase.",
      "Session settings: apg_write_forward.consistency_mode for Aurora PostgreSQL, aurora_replica_read_consistency for Aurora MySQL, and the forwarding status on each secondary cluster.",
      "Primary headroom: max_connections, forwarded sessions, and whether the primary is rejecting forwarded work because the forwarding connection allowance is exhausted.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the forwarded p99 with the application write timeout, then compare the same workload on the direct primary endpoint. If timeouts appear, check for duplicate side effects before retrying in bulk. If reads are stale, check the session consistency mode before blaming replication lag.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Decide whether the write path needs forwarding for endpoint simplicity or direct primary access for latency. Do not use forwarding just because the app is in the secondary Region.",
      "If forwarding stays, make every write retry idempotent. A timeout can follow a committed transaction, so the retry must not create a second order, payment, or message.",
      "Check the primary's forwarding connection allowance. Forwarded sessions consume the primary's connection pool, and a low allowance rejects new forwarded work.",
      "Use session consistency only on read paths that must see the user's own write. Leave other reads eventual and local.",
      "Move latency-sensitive writes to the primary endpoint or a closer Region. Raising the timeout alone moves the failure from errors to slow requests.",
      "Watch ForwardingReplicaReadWaitLatency and the application's read latency together when session consistency is on.",
      "Test a Regional failover: a promoted secondary stops being a forwarding target and becomes the writer, so endpoint assumptions must be rehearsed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Forwarding simplifies the application endpoint model but adds a hop and session handling to every write.",
      "Session consistency gives read-after-write correctness but makes the read wait for cross-Region replication.",
      "Eventual consistency keeps reads fast but exposes stale data immediately after a write.",
      "Direct primary writes remove the forwarding hop, but every Region needs the primary endpoint and must handle its own read routing.",
      "A longer timeout hides the latency from the client only if the work can wait; it does not shorten the cross-Region trip.",
      "Forwarding does not support every statement, so DDL and some session features still require the primary.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-forwarding-does",
    question: "What does Aurora write forwarding do, and what does it not do?",
    difficulty: 3,
    hints: [
      "Name the endpoint the client uses and the cluster that commits.",
      "Separate endpoint convenience from writer topology and latency.",
    ],
    answer:
      "Write forwarding lets a client connect to a secondary cluster's reader endpoint and send write statements. Aurora forwards each statement to the primary cluster, which executes and commits it, then replicates the change back to the secondary clusters. It does not create a second writer, make the write local, or remove the cross-Region latency. It also does not make every statement forwardable: DDL and some session features are unsupported and must run on the primary. The primary remains the source of truth.",
    followUps: [
      "Which endpoint does the application use?",
      "How does the primary stay the only writer?",
      "What happens to a statement that forwarding does not support?",
    ],
    redFlags: [
      "Says the secondary becomes writable.",
      "Claims forwarding removes cross-Region latency.",
      "Ignores unsupported statements.",
    ],
    rubric: [
      "Names the secondary reader endpoint and primary writer.",
      "States that the primary commits.",
      "Separates endpoint choice from writer topology.",
      "Names latency and SQL compatibility limits.",
    ],
  },
  {
    id: "timeout-after-commit",
    question:
      "A forwarded write times out at the client. How do you determine whether it committed, and how do you make the retry safe?",
    difficulty: 4,
    hints: [
      "A client timeout is not a database rollback.",
      "The primary's commit and the client's acknowledgment are separate events.",
    ],
    answer:
      "I would treat the outcome as unknown, not failed. I would look for the write on the primary using the application's idempotency key, natural key, or an outbox record, and check the primary's commit and forwarding metrics around the timeout. The retry must carry the same idempotency key so the database or application can reject a duplicate. If the write is not idempotent and cannot be looked up, the incident becomes a reconciliation task, not a blind retry. I would also compare the forwarded p99 with the client timeout and consider the direct primary path.",
    followUps: [
      "Where would you store the idempotency key?",
      "What if the write has an external side effect such as a payment?",
      "How would you detect duplicates after the fact?",
    ],
    redFlags: [
      "Assumes a timeout means rollback.",
      "Retries without an idempotency key.",
      "Blames the database without checking the commit.",
    ],
    rubric: [
      "Treats the outcome as unknown.",
      "Uses an idempotency key or lookup.",
      "Separates commit from acknowledgment.",
      "Plans reconciliation for non-idempotent writes.",
    ],
  },
  {
    id: "choose-topology",
    question:
      "When would you use write forwarding instead of connecting the secondary-region application directly to the primary writer?",
    difficulty: 3,
    hints: [
      "Think about endpoint management and how many Regions the app runs in.",
      "Latency and SQL compatibility are the constraints.",
    ],
    answer:
      "I would use forwarding when the application benefits from a single local endpoint per Region, the write volume is modest, and the added hop still fits the write timeout. It is a good fit for occasional writes and read-after-write flows that can use session consistency. I would avoid it for latency-sensitive or high-volume writes, for workloads that need DDL or unsupported session features, and when the primary's forwarding connection allowance is tight. In those cases I would connect to the primary writer endpoint, or move the write path closer, and route read-after-write reads explicitly.",
    followUps: [
      "How does write volume change the decision?",
      "What does session consistency cost?",
      "How would a Regional failover change the endpoint plan?",
    ],
    redFlags: [
      "Chooses forwarding for every workload.",
      "Ignores the timeout and SQL limits.",
      "Forgets read-after-write routing.",
    ],
    rubric: [
      "Matches forwarding to modest, occasional writes.",
      "Names the latency and compatibility limits.",
      "Mentions the primary connection allowance.",
      "Keeps direct primary access as an alternative.",
    ],
  },
];

const checklist = [
  {
    title: "Before enabling",
    items: [
      "The application's write timeout and retry behavior are known and tested.",
      "Every write has an idempotency key or a safe lookup path.",
      "The SQL surface is checked against the forwarding compatibility list.",
      "The primary's forwarding connection allowance leaves room for normal sessions.",
      "Read paths are classified as needing session consistency or tolerating eventual reads.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare forwarded p99 with the direct primary path before changing topology.",
      "Check whether timed-out writes committed and whether retries duplicated them.",
      "Check ForwardingReplicaReadWaitLatency when read latency rises after writes.",
      "Check whether the primary is rejecting forwarded sessions because its allowance is full.",
      "Record the endpoint, consistency mode, and timeout in the incident timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Decide whether forwarding remains the right path for each write class.",
      "Tune or remove the timeout instead of hiding a path that cannot meet it.",
      "Keep session consistency scoped to the reads that need it.",
      "Rehearse promotion of the secondary: forwarding stops when it becomes the writer.",
    ],
  },
];

const references = [
  {
    title: "Using write forwarding in an Amazon Aurora global database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-write-forwarding.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How secondary clusters forward writes to the primary and how changes propagate back.",
  },
  {
    title: "Using write forwarding in an Aurora PostgreSQL global database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-write-forwarding-apg.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "apg_write_forward.consistency_mode, SQL restrictions, connection allowances, and forwarding metrics.",
  },
  {
    title: "Using write forwarding in an Aurora MySQL global database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-write-forwarding-ams.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "aurora_replica_read_consistency, transaction behavior, and the writer connection percentage setting.",
  },
  {
    title: "Using Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Primary and secondary cluster roles and cross-Region replication.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "write-forwarding": {
      model: writeForwardingModel,
      presets,
      instructions:
        "Start healthy, apply Forwarded write timeout, then compare session and eventual consistency. Turn forwarding off to isolate the extra hop from the cross-Region round trip.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Latency, timeout, and workload values are teaching inputs, not Aurora limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-aurora-global",
    "databases-cross-region-rpo",
    "databases-read-after-write",
    "databases-failover-dns",
  ],
};
