import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PROCESS_PER_TASK = 5_000;
const RESTORE_PARALLEL_CAP = 4;
const MAX_READY = 3_600;

const params = [
  {
    id: "stateSizeGB",
    label: "State store size",
    min: 5,
    max: 200,
    step: 5,
    value: 40,
    unit: " GB",
    group: "State",
    help: "Gigabytes in the local state store. A restart has to rebuild this from the changelog before the query can process normally.",
    format: "number" as const,
  },
  {
    id: "changelogMBps",
    label: "Restore throughput",
    min: 10,
    max: 120,
    step: 5,
    value: 40,
    unit: " MB/s",
    group: "Changelog",
    help: "Changelog bytes one restore task can read per second. The changelog topic must have enough partitions and broker capacity to serve them.",
    format: "number" as const,
  },
  {
    id: "inputRate",
    label: "Input records",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 8_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records arriving while the query is restoring. They accumulate as lag until the state store is ready.",
    format: "rps" as const,
  },
  {
    id: "tasks",
    label: "Query tasks",
    min: 1,
    max: 8,
    step: 1,
    value: 4,
    unit: "",
    group: "Query",
    help: "Parallel tasks for the persistent query. Tasks restore state in parallel and each adds processing capacity, up to the input partition count.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  stateGB: number;
  changelogMBps: number;
  input: number;
  tasks: number;
  restoreParallel: number;
  restoreRate: number;
  restoreSeconds: number;
  processRate: number;
  drainRate: number;
  backlogAtRestore: number;
  totalSeconds: number;
  restoring: boolean;
  progress: number;
  lag: number;
  timeToReady: number;
  processingLoad: number;
}

function compute(p: Params, t: number): Computed {
  const stateGB = Math.max(1, num(p, "stateSizeGB", 40));
  const changelogMBps = Math.max(1, num(p, "changelogMBps", 40));
  const input = Math.max(1, num(p, "inputRate", 8_000));
  const tasks = Math.max(1, Math.round(num(p, "tasks", 4)));
  const restoreParallel = Math.min(tasks, RESTORE_PARALLEL_CAP);
  const restoreRate = changelogMBps * restoreParallel;
  const restoreSeconds = (stateGB * 1_024) / restoreRate;
  const processRate = tasks * PROCESS_PER_TASK;
  const drainRate = processRate - input;
  const backlogAtRestore = input * restoreSeconds;
  const catchUpSeconds = drainRate > 0 ? backlogAtRestore / drainRate : MAX_READY;
  const totalSeconds = Math.min(MAX_READY, restoreSeconds + catchUpSeconds);
  const restoring = t < restoreSeconds;
  const progress = restoreSeconds > 0 ? Math.min(100, (t / restoreSeconds) * 100) : 100;
  let lag: number;
  if (restoring) {
    lag = input * t;
  } else if (drainRate >= 0) {
    lag = Math.max(0, backlogAtRestore - drainRate * (t - restoreSeconds));
  } else {
    lag = backlogAtRestore + -drainRate * (t - restoreSeconds);
  }
  return {
    stateGB,
    changelogMBps,
    input,
    tasks,
    restoreParallel,
    restoreRate,
    restoreSeconds,
    processRate,
    drainRate,
    backlogAtRestore,
    totalSeconds,
    restoring,
    progress,
    lag,
    timeToReady: Math.max(0, totalSeconds - t),
    processingLoad: (input / processRate) * 100,
  };
}

function healthFor(c: Computed): "ok" | "warn" | "crit" {
  if (c.timeToReady >= 300 || c.lag >= 300_000 || c.processingLoad >= 90) return "crit";
  if (c.timeToReady >= 60 || c.lag >= 100_000 || c.processingLoad >= 75) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, flags: SimFrame["flags"]): SimFrame {
  const c = compute(p, t);
  const health = healthFor(c);
  return {
    t,
    nodes: [
      {
        id: "input",
        label: "orders topic",
        kind: "stream",
        health: c.lag >= 300_000 ? "crit" : c.lag >= 100_000 ? "warn" : "ok",
        throughput: c.input,
        sublabel: `${Math.round(c.input).toLocaleString("en-US")} rec/s arriving`,
        meta: { view: "flow" },
      },
      {
        id: "changelog",
        label: "state changelog",
        kind: "stream",
        health: c.restoring ? "warn" : "ok",
        sublabel: `${Math.round(c.restoreRate)} MB/s restore`,
        detail: `The changelog is a compacted Kafka topic. One restore task reads ${Math.round(c.changelogMBps)} MB/s, and up to ${RESTORE_PARALLEL_CAP} tasks restore in parallel.`,
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "enrichment query",
        kind: "service",
        health,
        utilization: clamp(c.processingLoad / 100),
        throughput: c.input,
        capacity: c.processRate,
        sublabel: `${c.tasks} tasks · ${Math.round(c.progress)}% restored`,
        detail: c.restoring
          ? `The query is rebuilding ${c.stateGB} GB of state from the changelog. It cannot process the input backlog until the store is ready. Estimated time to ready is ${Math.round(c.timeToReady)} s.`
          : `The state store is ready. The query processes at ${Math.round(c.processRate).toLocaleString("en-US")} rec/s against ${Math.round(c.input).toLocaleString("en-US")} rec/s of input. Lag is ${Math.round(c.lag).toLocaleString("en-US")} records.`,
        meta: {
          tasks: c.tasks,
          restoreSeconds: c.restoreSeconds,
          lag: c.lag,
          timeToReady: c.timeToReady,
        },
      },
      {
        id: "store",
        label: "local state store",
        kind: "db",
        health: c.restoring ? "warn" : health,
        utilization: clamp(c.progress / 100),
        sublabel: `${Math.round(c.progress)}% · ${Math.round(c.stateGB)} GB`,
        detail: "The store is local to the task. A task on another host cannot reuse it, so a restart or rebalance usually starts the rebuild again from the changelog.",
        meta: { view: "flow" },
      },
      {
        id: "output",
        label: "enriched.orders",
        kind: "stream",
        health: health,
        throughput: c.restoring ? 0 : Math.max(0, Math.min(c.processRate, c.input)),
        sublabel: c.restoring ? "waiting for state" : "query output",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("input-query", "input", "query", clamp(c.input / 40_000), health),
      edge("changelog-query", "changelog", "query", clamp(c.restoreRate / 500), c.restoring ? "warn" : "ok"),
      edge("query-store", "query", "store", clamp(c.progress / 100), c.restoring ? "warn" : "ok"),
      edge("query-output", "query", "output", clamp(c.processingLoad / 100), health),
    ],
    metrics: [
      metric("time-to-ready", "Time to catch up", c.timeToReady, " s", 60, 300, "number"),
      metric("consumer-lag", "Consumer lag", c.lag, " records", 100_000, 300_000, "count"),
      metric("processing-load", "Processing load", c.processingLoad, "%", 75, 90, "percent"),
      metric("restore-progress", "State restored", c.progress, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { ...flags, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(c.progress)}% of ${Math.round(c.stateGB)} GB restored; ${Math.round(c.timeToReady)} s to ready and ${Math.round(c.lag).toLocaleString("en-US")} records behind.`,
  };
}

function seedSeries(frame: SimFrame, c: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.4);
  const seedValues: [string, number, number][] = [
    ["time-to-ready", c.timeToReady, 2],
    ["consumer-lag", c.lag, 2_000],
    ["processing-load", c.processingLoad, 2],
    ["restore-progress", c.progress, 2],
  ];
  for (const [id, value, amplitude] of seedValues) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2) * amplitude),
    );
  }
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "recovery-slo",
    metricId: "time-to-ready",
    warn: 60,
    crit: 300,
    title: "State rebuild exceeds the recovery SLO",
    cause:
      "The query must rebuild its local state store from the compacted changelog before it can process new input. State size divided by restore throughput, plus the backlog that arrived during the rebuild, is the recovery time.",
    fix:
      "Reduce state size, increase restore throughput, add tasks up to the changelog partition count, or raise the SLO with a documented degraded mode. Rebalancing and restarting a task still triggers a rebuild.",
    checkFirst: [
      "Measure the state store size per task, not the total topic size.",
      "Measure changelog read throughput during restore and compare it with the broker limit.",
      "Check whether task count is below the input partition count.",
    ],
  },
  {
    id: "state-lag",
    metricId: "consumer-lag",
    warn: 100_000,
    crit: 300_000,
    title: "Input lag grows while the state store is unavailable",
    cause:
      "A restoring task does not process input, but producers keep writing. The backlog grows at the input rate and then has to drain at the difference between processing and input rates.",
    fix:
      "Restore the state faster, shed or pause non-critical input during recovery, and ensure processing capacity exceeds the input rate after restore. Lag alone is not a recovery plan.",
    checkFirst: [
      "Compare lag growth with the input rate during the restart window.",
      "Check whether the query can process before 100% of state is restored.",
      "Check whether the input rate exceeds the post-restore processing rate.",
    ],
  },
  {
    id: "processing-load",
    metricId: "processing-load",
    warn: 75,
    crit: 90,
    title: "The query has no processing headroom after recovery",
    cause:
      "Task count, not state size, sets steady-state capacity. If input is close to the combined processing rate, the backlog from the restart never drains and the next restart starts from a worse position.",
    fix:
      "Add tasks up to the partition count, reduce per-record work, or shed load. More tasks also add restore parallelism, so capacity and recovery improve together until the partition cap.",
    checkFirst: [
      "Compare input rate with processing rate per task.",
      "Check whether task count matches the input partition count.",
      "Check for a downstream call inside the query that caps throughput.",
    ],
  },
];

export const ksqlDbModel: SimModel = {
  id: "streaming-ksqldb",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, { seed });
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p) => {
    const c = compute(p, frame.t);
    const next = buildFrame(p, frame.t, frame.flags);
    next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (c.timeToReady >= 300 && frame.flags.sloEvent !== 1) {
      pushEvent(next, {
        id: "restore-slo-breach",
        at: frame.t,
        severity: "crit",
        title: "Restart will miss the recovery SLO",
        detail: `The state store is ${Math.round(c.progress)}% restored and the estimated time to ready is ${Math.round(c.timeToReady)} s. Input keeps arriving at ${Math.round(c.input).toLocaleString("en-US")} rec/s, so the backlog is growing during the rebuild.`,
        nodeId: "query",
        metricId: "time-to-ready",
      });
    }
    next.flags.sloEvent = c.timeToReady >= 300 ? 1 : 0;

    if (c.progress >= 100 && frame.flags.restored !== 1 && frame.t > 0) {
      pushEvent(next, {
        id: "state-store-restored",
        at: frame.t,
        severity: "info",
        title: "State store restored",
        detail: `The query has rebuilt ${Math.round(c.stateGB)} GB from the changelog and can process input. Lag is ${Math.round(c.lag).toLocaleString("en-US")} records.`,
        nodeId: "store",
        metricId: "restore-progress",
      });
    }
    next.flags.restored = c.progress >= 100 ? 1 : 0;

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `The store restores at about ${Math.round(c.restoreRate)} MB/s across ${c.restoreParallel} task(s), so ${Math.round(c.stateGB)} GB needs about ${Math.round(c.restoreSeconds)} s before input processing resumes.`,
    );
    if (c.restoring) {
      items.push(
        `Input keeps arriving at ${Math.round(c.input).toLocaleString("en-US")} rec/s. The backlog is ${Math.round(c.lag).toLocaleString("en-US")} records and is not being drained yet.`,
      );
    }
    if (c.drainRate <= 0) {
      items.push(
        "Processing capacity is at or below the input rate. The backlog never drains, so restart time is not the only SLO at risk.",
      );
    } else {
      items.push(
        `After restore, the query drains at ${Math.round(c.drainRate).toLocaleString("en-US")} rec/s of headroom. Total time to catch up is about ${Math.round(c.totalSeconds)} s.`,
      );
    }
    items.push(`Task count is ${c.tasks}; restore parallelism is capped at ${RESTORE_PARALLEL_CAP} in this illustrative model.`);
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Restoring", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Small state, fast changelog, and enough tasks to restore and drain quickly.",
    tone: "ok",
    elapsed: 30,
    params: defaults({ stateSizeGB: 8, changelogMBps: 120, inputRate: 6_000, tasks: 4 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A larger store and slower restore push the restart into the warning band.",
    tone: "warn",
    params: defaults({ stateSizeGB: 80, changelogMBps: 25, inputRate: 10_000, tasks: 4 }),
  },
  {
    id: "failure",
    label: "State rebuild",
    description: "A 120 GB store restores at 40 MB/s while input exceeds processing capacity.",
    tone: "crit",
    params: defaults({ stateSizeGB: 120, changelogMBps: 20, inputRate: 12_000, tasks: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A smaller store, faster changelog, and six tasks restore and drain within the SLO.",
    tone: "ok",
    params: defaults({ stateSizeGB: 10, changelogMBps: 100, inputRate: 10_000, tasks: 6 }),
  },
];

const experiment: Experiment = {
  id: "predict-more-tasks",
  title: "Predict what more tasks do to a restart",
  simId: "ksqldb",
  question:
    "A query has two tasks, an 80 GB state store, and a changelog that restores at 25 MB/s per task. Input is 10k rec/s and one task processes 5k rec/s. You double the task count to four. What changes?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing, because state size is unchanged" },
      { id: "faster", label: "Restore parallelizes up to the cap and processing capacity exceeds input, so recovery is faster" },
      { id: "slower", label: "Restart gets slower because more tasks mean more rebalancing" },
      { id: "data-loss", label: "State is lost because tasks cannot share a store" },
    ],
    correctOptionId: "faster",
    explanation:
      "Task count affects two things. Each task restores its own share of the changelog, so restore throughput scales with tasks up to the restore parallelism cap and the changelog partition count. Each task also adds processing capacity. Going from two to four tasks raises restore throughput and raises processing capacity from 10k to 20k rec/s, which is above the 10k input rate. The backlog that arrived during restore can then drain. Rebalancing adds a pause, but it does not erase the capacity gain.",
  },
  setup: defaults({ stateSizeGB: 80, changelogMBps: 25, inputRate: 10_000, tasks: 2 }),
  runFor: 30,
  observe: [
    "Time to ready starts near the one-hour cap because processing capacity equals the input rate.",
    "Lag grows while the store is restoring and never drains at two tasks.",
    "At four tasks, restore throughput doubles and processing capacity is twice the input rate.",
    "The state store still has to fit on the task's local disk; more tasks do not shrink the total state.",
  ],
  explain:
    "The restart has two phases: restore and drain. Restore time is state size divided by restore throughput. Drain time is the backlog that accumulated during restore divided by the processing headroom. Task count changes both terms, but it is bounded by the number of input partitions and by local disk. If input is at or above processing capacity, no amount of restore speed prevents the backlog from growing.",
  fix: defaults({ stateSizeGB: 80, changelogMBps: 80, inputRate: 10_000, tasks: 6 }),
  debrief:
    "Six tasks restore at 320 MB/s and process 30k rec/s against 10k of input. The same 80 GB rebuild finishes in about 10 s and the backlog drains in a few more. The cost is more local state directories, more changelog consumers, and a larger rebalance surface. The durable fix is to keep state small and processing headroom positive, not to rely on a fast disk at restart time.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "ksqlDB runs persistent queries over Kafka topics. A stateless query can restart and resume from its committed offset. A stateful query, such as an aggregation, join, or materialized table, also keeps a local state store. The store is backed by a compacted changelog topic. On restart, the query must rebuild the store from that changelog before it can process new input correctly.",
  },
  {
    type: "p",
    text: "That rebuild is the hidden recovery cost. The output topic is current, the consumer group looks healthy, and the query process is running, but the task is replaying its changelog. Input keeps arriving and becomes lag. The restart is complete only when the state is restored and the accumulated backlog is drained. A 20-minute catch-up can be 15 minutes of restore and 5 minutes of drain, or it can be an input rate that will never let the backlog drain at all.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is input topic, query task, local state store, changelog topic, and output topic. The input partition count caps the task count. Each task owns a slice of state and a slice of the changelog. Restore throughput is bounded by the changelog partitions, broker read capacity, and per-task restore speed. The output and the state changelog are written by the same processing path, which is why the processing guarantee matters for both.",
  },
  {
    type: "table",
    headers: ["Component", "Role", "Recovery cost"],
    rows: [
      ["Input topic", "New records to process", "Keeps growing while the task restores"],
      ["Local state store", "Working set for joins and aggregations", "Must be rebuilt if the task moves hosts"],
      ["Changelog topic", "Compacted backup of state changes", "Read throughput sets restore speed"],
      ["Query task", "Owns one partition slice", "Adds processing capacity and restore parallelism"],
      ["Output topic", "Query result", "Cannot be trusted until state is ready"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses illustrative values: 5 to 200 GB of state, 10 to 120 MB/s per restore task, and 5k records per second of processing per task. They are teaching numbers, not ksqlDB limits or a benchmark. The relationships are the lesson: restore time is state divided by throughput, and drain time is backlog divided by headroom.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to catch up: remaining restore time plus the time to drain the backlog at the current processing headroom.",
      "Consumer lag: records that arrived while the state store was rebuilding and have not been processed.",
      "Processing load: input rate against combined task capacity. Above 100%, the backlog never drains.",
      "State restored: progress through the changelog replay, which is not the same as being ready to serve.",
      "A flow view with the input topic, query, local store, changelog, and output.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply State rebuild. Watch the restore progress and lag grow together. Apply Recovery and compare time to catch up. Run the experiment before increasing task count: predict which term of the recovery changes.",
  },
  { type: "sim", simId: "ksqldb" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset had 120 GB of state and two tasks restoring at 20 MB/s each, so the changelog replay alone needed about 154 seconds. Input arrived at 12k rec/s while the two tasks could process only 10k rec/s, so the backlog grew during the rebuild and could not drain afterward. Time to catch up hit the one-hour cap, lag passed 700k records by the one-minute mark, and processing load was above 100%. The query was running, but it was not serving.",
  },
  {
    type: "p",
    text: "The recovery preset used a 10 GB store, 100 MB/s per restore task, and six tasks. The restore finished in about 26 seconds, the 256k-record backlog drained at 20k rec/s of headroom, and the query was ready in about 38 seconds. Lag returned to zero before the 60-second mark. The improvement came from both terms: less state to read, more parallel restore, and more processing capacity than input.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ksqlDB query status: RUNNING is not the same as caught up; check the state store restore and the consumer lag.",
      "Changelog topic metrics: bytes read, fetch latency, and partition count during restore.",
      "Consumer lag on the input topic, split by task and partition, with the input rate alongside it.",
      "Local disk usage and read latency on the task hosts, which cap restore speed.",
      "Rebalance events and task migrations, which restart the restore from the changelog on the new host.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split recovery into restore and drain. Measure state size per task and changelog read throughput. Then compare input rate with combined processing capacity. If input is at or above capacity, the backlog never drains, and the restart time is only part of the incident.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure state size per task and the restore throughput actually achieved, not the configured broker limit.",
      "Add tasks up to the input partition count so restore and steady-state capacity scale together.",
      "Reduce state: shorter windows, fewer materialized tables, or a smaller key space.",
      "Make the changelog compacted and sized for parallel reads; check broker throttles during restore.",
      "Shed or pause non-critical input during the rebuild so the backlog does not outrun the drain rate.",
      "Keep processing headroom above peak input, or the next restart begins from a larger backlog.",
      "Set an SLO on time to catch up and alert on it, not only on process health.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More tasks improve restore and throughput but add local state directories, changelog consumers, and rebalance work.",
      "A smaller state store recovers faster but may remove history that joins or windows need.",
      "A larger state store can simplify query logic while making every restart and migration more expensive.",
      "Standby capacity or warm replicas shorten recovery but cost money and still consume changelog bandwidth.",
      "Exactly-once processing protects the output and the state changelog, but an external sink still needs its own idempotency.",
      "A tight recovery SLO can force a topology redesign; a loose one can hide a system that never truly catches up.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-restart-slow",
    question:
      "A ksqlDB persistent query restarts and takes 20 minutes to catch up. How do you break that time down?",
    difficulty: 3,
    hints: [
      "Separate state restore from input backlog drain.",
      "State size divided by restore throughput is the first term.",
    ],
    answer:
      "I would split it into restore and drain. Restore time is state size per task divided by the changelog read throughput per task. Drain time is the backlog that arrived during restore divided by the difference between processing rate and input rate. I would measure state size per task, changelog bytes read per second, task count, input rate, and processing capacity. If input is at or above processing capacity, the drain term is unbounded and the query will never catch up. I would also check for a rebalance or task migration that restarted the restore.",
    followUps: [
      "Which term would you attack first?",
      "What does task count change in each term?",
      "How would you know the state is fully restored?",
    ],
    redFlags: [
      "Says the query is running, so it is healthy.",
      "Looks only at total state size.",
      "Adds consumers without checking partitions.",
    ],
    rubric: [
      "Separates restore and drain.",
      "Uses state size and throughput.",
      "Checks processing headroom.",
      "Names a measurement for each term.",
    ],
  },
  {
    id: "reduce-restore-time",
    question:
      "How do you reduce state restore time without losing correctness?",
    difficulty: 3,
    hints: [
      "More tasks restore in parallel, up to the partition count.",
      "State size and changelog throughput are both levers.",
    ],
    answer:
      "I would increase task count up to the input and changelog partition count so restore parallelizes, and verify the broker can serve the aggregate read rate. I would reduce state where the query allows it: shorter windows, fewer materialized tables, and a smaller key space. I would make sure the changelog is compacted and not being throttled, and I would avoid unnecessary restarts or migrations that force a rebuild. Caching or a warm replica can hide the rebuild, but it does not remove the changelog read; I would treat it as a latency optimization, not a correctness change.",
    followUps: [
      "What caps restore parallelism?",
      "Why can a rebalance be worse than a process restart?",
      "What is the risk of a smaller state store?",
    ],
    redFlags: [
      "Suggests deleting the changelog.",
      "Adds tasks beyond the partition count.",
      "Assumes local disk always survives a restart.",
    ],
    rubric: [
      "Names parallel restore and its cap.",
      "Reduces state with a correctness caveat.",
      "Checks changelog and broker throughput.",
      "Distinguishes hiding from removing the rebuild.",
    ],
  },
  {
    id: "ksqldb-exactly-once",
    question:
      "What does exactly-once mean for a stateful ksqlDB query, and where does the guarantee stop?",
    difficulty: 4,
    hints: [
      "The output record and the state changelog are both Kafka writes.",
      "An external sink is still a separate effect.",
    ],
    answer:
      "The underlying Kafka Streams processing guarantee makes the output records, the state store changelog records, and the consumed offsets part of one transactional write for the Kafka-side effects. A restart then does not double-apply a state update or emit a duplicate committed output. The guarantee stops at Kafka. If the query writes to an external system through a connector or a user-defined function, that effect needs its own idempotency or transaction. I would check the configured processing guarantee, the sink's key, and the consumer isolation level before claiming end-to-end exactly-once.",
    followUps: [
      "Which records are in the transaction?",
      "What happens to an aborted transaction's state changes?",
      "How would you verify the guarantee after a crash?",
    ],
    redFlags: [
      "Claims exactly-once covers external APIs.",
      "Ignores the state changelog.",
      "Confuses producer idempotence with a transaction.",
    ],
    rubric: [
      "Includes output, changelog, and offsets.",
      "States the Kafka boundary.",
      "Requires sink idempotency.",
      "Names a verification method.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "State size per task and changelog restore throughput are measured and charted.",
      "The query has processing headroom above peak input, not only average input.",
      "Task count is aligned with input and changelog partition counts.",
      "A restart drill measures time to catch up, not only process start time.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split the delay into restore and drain before changing capacity.",
      "Check changelog read throughput and broker throttles during the rebuild.",
      "Shed non-critical input if the backlog is growing faster than the drain rate.",
      "Record task migrations and rebalances that restart the restore.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify lag reaches zero and stays there at peak.",
      "Right-size state and task count against the recovery SLO.",
      "Remove unused materialized tables and shorten windows where possible.",
      "Re-run the restart drill with the real state size.",
    ],
  },
];

const references = [
  {
    title: "Confluent ksqlDB capacity planning: state store changelog topics",
    url: "https://docs.confluent.io/platform/current/ksqldb/operate-and-deploy/capacity-planning.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "State stores, changelog topics, and capacity considerations for persistent queries.",
  },
  {
    title: "Confluent ksqlDB: stateful stream processing concepts",
    url: "https://docs.confluent.io/platform/current/ksqldb/concepts/stateful-stream-processing.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "State stores, changelogs, and how stateful queries recover.",
  },
  {
    title: "Confluent Cloud ksqlDB overview",
    url: "https://docs.confluent.io/cloud/current/ksql/overview.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Managed ksqlDB behavior, persistence, and operational boundaries.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    ksqldb: {
      model: ksqlDbModel,
      presets,
      instructions:
        "Start Healthy, then apply State rebuild. Watch state restored, lag, and time to catch up together. Apply Recovery before changing tasks, then run the experiment.",
      experimentIds: [experiment.id],
      note: "Illustrative model. State sizes, restore rates, and processing capacity are teaching values, not ksqlDB benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-transactions",
    "streaming-exactly-once",
    "streaming-consumer-lag",
    "streaming-retention",
  ],
};
