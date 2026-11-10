import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RESTART_SECONDS = 8;
const KILL_ALERT_SECONDS = 20;

const params: ParamSpec[] = [
  {
    id: "memoryLimitMiB",
    label: "Task memory limit",
    min: 512,
    max: 4_096,
    step: 256,
    value: 1_024,
    unit: " MiB",
    group: "Limit",
    help: "The hard memory limit for the task. The kernel cannot let the working set stay above this ceiling.",
    format: "number",
  },
  {
    id: "baselineUsageMiB",
    label: "Baseline memory",
    min: 128,
    max: 3_072,
    step: 128,
    value: 400,
    unit: " MiB",
    group: "Workload",
    help: "Memory the task uses after startup, before any growth. A restart returns the task to this level.",
    format: "number",
  },
  {
    id: "growthMiBPerMinute",
    label: "Memory growth",
    min: 0,
    max: 240,
    step: 10,
    value: 20,
    unit: " MiB/min",
    group: "Workload",
    help: "How fast the working set grows at the reference traffic level. A leak or a retained cache produces a persistent slope.",
    format: "number",
  },
  {
    id: "trafficMultiplier",
    label: "Traffic multiplier",
    min: 0.5,
    max: 3,
    step: 0.1,
    value: 1,
    unit: "×",
    group: "Workload",
    help: "Scales memory growth with request volume. More traffic can make an existing leak reach the limit sooner.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  limit: number;
  baseline: number;
  growthPerMinute: number;
  traffic: number;
  ratePerSecond: number;
  usage: number;
  pressure: number;
  oomCount: number;
  phase: string;
  timeToLimit: number;
}

function compute(p: Params, usage: number, oomCount: number, phase: string): Values {
  const limit = clamp(num(p, "memoryLimitMiB", 1_024), 512, 4_096);
  const baseline = clamp(num(p, "baselineUsageMiB", 400), 128, 3_072);
  const growthPerMinute = clamp(num(p, "growthMiBPerMinute", 20), 0, 240) * clamp(num(p, "trafficMultiplier", 1), 0.5, 3);
  const ratePerSecond = growthPerMinute / 60;
  const pressure = (usage / limit) * 100;
  const timeToLimit = ratePerSecond > 0 ? Math.max(0, (limit - usage) / ratePerSecond) : 0;
  return {
    limit,
    baseline,
    growthPerMinute,
    traffic: clamp(num(p, "trafficMultiplier", 1), 0.5, 3),
    ratePerSecond,
    usage,
    pressure,
    oomCount,
    phase,
    timeToLimit,
  };
}

function buildFrame(seed: number, values: Values, recentlyKilled: boolean): SimFrame {
  const health: Health =
    values.pressure >= 100 || recentlyKilled || values.oomCount >= 2
      ? "crit"
      : values.pressure >= 80 || values.growthPerMinute >= 60 || values.oomCount >= 1
        ? "warn"
        : "ok";
  const serviceHealth: Health = values.oomCount > 0 ? "crit" : health;
  const nodes: SimNode[] = [
    {
      id: "task",
      label: "checkout-task",
      kind: "service",
      health,
      utilization: clamp(values.pressure / 100),
      sublabel: `${Math.round(values.usage)} / ${Math.round(values.limit)} MiB`,
      detail:
        values.phase === "restarting"
          ? `The task is restarting after an OOM kill. Usage is pinned at the ${Math.round(values.limit)} MiB limit until the replacement starts.`
          : `The task is ${values.phase === "running" ? "running" : "waiting to restart"}. Its working set is ${Math.round(values.usage)} MiB against a ${Math.round(values.limit)} MiB limit.`,
      meta: { usage: values.usage, limit: values.limit },
    },
    {
      id: "cgroup",
      label: "Memory cgroup",
      kind: "service",
      health,
      utilization: clamp(values.pressure / 100),
      sublabel: `${values.pressure.toFixed(0)}% · ${values.growthPerMinute.toFixed(0)} MiB/min`,
      detail: `The control group tracks the task's memory. At the limit the kernel tries to reclaim, then invokes the OOM killer. The slope is ${values.growthPerMinute.toFixed(0)} MiB per minute at this traffic level.`,
      meta: { pressure: Number(values.pressure.toFixed(1)), growth: Number(values.growthPerMinute.toFixed(1)) },
    },
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health: serviceHealth,
      sublabel: `${values.oomCount} OOM restart${values.oomCount === 1 ? "" : "s"}`,
      detail:
        values.oomCount > 0
          ? `The service has replaced the task ${values.oomCount} time(s). Each replacement resets memory to baseline and starts the same growth path unless the workload or the limit changes.`
          : "The service has not replaced this task for an OOM kill in the simulated window.",
      meta: { oomCount: values.oomCount },
    },
    {
      id: "last-stop",
      label: "Last stop reason",
      kind: "worker",
      health: values.oomCount > 0 ? "crit" : "ok",
      utilization: values.oomCount > 0 ? 1 : 0,
      sublabel: values.oomCount > 0 ? "exit 137 · OOM" : "no stop recorded",
      detail:
        values.oomCount > 0
          ? "The task was killed with SIGKILL and reported exit code 137. The memory stop reason and the rising memory curve distinguish this from CPU throttling."
          : "No OOM stop has occurred. CPU throttling would slow the task and leave it running, not produce exit 137.",
      meta: { exitCode: values.oomCount > 0 ? 137 : 0 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("task-cgroup", "task", "cgroup", clamp(values.pressure / 100), health, "working set"),
      edge("service-task", "service", "task", values.oomCount > 0 ? 1 : 0.4, serviceHealth, "replaces"),
      edge("cgroup-stop", "cgroup", "last-stop", values.oomCount > 0 ? 1 : 0.05, values.oomCount > 0 ? "crit" : "ok", "SIGKILL"),
    ],
    metrics: [
      metric("memory-pressure", "Memory usage against limit", values.pressure, "%", 80, 100, "percent"),
      metric("memory-growth", "Memory growth rate", values.growthPerMinute, " MiB/min", 60, 150, "number"),
      metric("oom-kills", "OOM kills", values.oomCount, "", 1, 2, "count"),
      metric("time-to-limit", "Time to memory limit (0 = flat)", values.timeToLimit, " s", undefined, undefined, "number"),
      metric("memory-used", "Memory used", values.usage, " MiB", undefined, undefined, "number"),
      metric("memory-limit", "Memory limit", values.limit, " MiB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, usage: values.usage, phase: values.phase, oomCount: values.oomCount },
    summary: `${Math.round(values.usage)}/${Math.round(values.limit)} MiB, ${values.growthPerMinute > 0 ? `growing ${values.growthPerMinute.toFixed(0)} MiB/min` : "memory flat"}, ${values.oomCount} OOM kill(s).`,
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
    id: "memory-pressure",
    metricId: "memory-pressure",
    warn: 80,
    crit: 100,
    title: "The task reached its memory limit",
    cause:
      "The working set grew until the task could not stay under its hard limit. The kernel reclaims what it can, then sends SIGKILL to the largest consumer in the control group. The task does not get a graceful shutdown.",
    fix:
      "Read the memory curve before the kill, not only the restart count. If the workload is leaking, fix the leak. If the limit is too low for the real workload, raise it and confirm the node can still place the task. Increasing the limit without understanding the slope only postpones the next kill.",
    checkFirst: [
      "Check the stopped task reason for a memory-specific message and the exit code.",
      "Graph memory before the stop; a rising slope points to growth, a flat ceiling points to an undersized limit.",
      "Compare the limit with the task size and node capacity before raising it.",
    ],
  },
  {
    id: "memory-growth",
    metricId: "memory-growth",
    warn: 60,
    crit: 150,
    title: "Memory is growing steadily toward the limit",
    cause:
      "A persistent slope usually means retained objects, an unbounded cache, a growing buffer, or a connection or metric registry that never releases entries. Traffic can scale the slope, but it does not explain a trend that continues at constant load.",
    fix:
      "Compare heap or allocation profiles across restarts and at the same request volume. Bound the cache or buffer, release references, and add an alert on the slope rather than only on the ceiling. A restart hides the trend because it resets the measurement.",
    checkFirst: [
      "Compare memory at the same point after each restart.",
      "Check whether growth tracks request volume or elapsed time.",
      "Look for unbounded caches, queues, or registries in the code path.",
    ],
  },
  {
    id: "oom-kills",
    metricId: "oom-kills",
    warn: 1,
    crit: 2,
    title: "The task is in an OOM restart loop",
    cause:
      "Each replacement starts from baseline and follows the same allocation path. Without a change to the workload or the limit, the next kill is predictable. The service may look available between kills, which makes the loop easy to miss.",
    fix:
      "Stop treating restarts as recovery. Capture the stop reason, exit code, and memory curve from the killed task, then fix the allocation or resize the task. If the task must restart while the fix is prepared, bound the restarts and alert on the frequency.",
    checkFirst: [
      "Count restarts and compare the interval with time to reach the limit.",
      "Capture memory immediately before the kill, not after the replacement.",
      "Check whether a deployment or traffic change altered the slope.",
    ],
  },
];

export const oomModel: SimModel = {
  id: "containers-oom-kills",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, num(p, "baselineUsageMiB", 400), 0, "running");
    const frame = buildFrame(seed, values, false);
    seedSeries(frame);
    frame.flags = {
      ...frame.flags,
      paramsKey: JSON.stringify(p),
      usage: values.usage,
      phase: "running",
      oomCount: 0,
      lastKillAt: -999,
      restartAt: 0,
    };
    return frame;
  },
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    const limit = clamp(num(p, "memoryLimitMiB", 1_024), 512, 4_096);
    const baseline = clamp(num(p, "baselineUsageMiB", 400), 128, 3_072);
    const growth = clamp(num(p, "growthMiBPerMinute", 20), 0, 240) * clamp(num(p, "trafficMultiplier", 1), 0.5, 3);
    let usage = reset ? baseline : Number(frame.flags.usage ?? baseline);
    let phase = reset ? "running" : String(frame.flags.phase ?? "running");
    let oomCount = reset ? 0 : Number(frame.flags.oomCount ?? 0);
    let lastKillAt = reset ? -999 : Number(frame.flags.lastKillAt ?? -999);
    let restartAt = reset ? 0 : Number(frame.flags.restartAt ?? 0);
    let killed = false;

    if (phase === "restarting" && frame.t >= restartAt) {
      phase = "running";
      usage = baseline;
    }
    if (phase === "running" && dt > 0) {
      usage += (growth / 60) * dt;
      if (usage >= limit) {
        usage = limit;
        oomCount += 1;
        phase = "restarting";
        lastKillAt = frame.t;
        restartAt = frame.t + RESTART_SECONDS;
        killed = true;
      }
    }

    const values = compute(p, usage, oomCount, phase);
    const seed = Number(frame.flags.seed ?? 1);
    const recentlyKilled = lastKillAt >= 0 && frame.t - lastKillAt < KILL_ALERT_SECONDS;
    const next = buildFrame(seed, values, recentlyKilled);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      paramsKey: key,
      usage,
      phase,
      oomCount,
      lastKillAt,
      restartAt,
    };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (killed) {
      pushEvent(next, {
        id: `oom-kill-${oomCount}`,
        at: frame.t,
        severity: "crit",
        title: "Task killed at the memory limit",
        detail: `Exit code 137 after SIGKILL. Stop reason: OutOfMemoryError. Memory reached ${Math.round(limit)} MiB.`,
        nodeId: "task",
        metricId: "memory-pressure",
      });
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(
      p,
      Number(frame.flags.usage ?? 400),
      Number(frame.flags.oomCount ?? 0),
      String(frame.flags.phase ?? "running"),
    );
    return [
      `The task is at ${Math.round(values.usage)} MiB against a ${Math.round(values.limit)} MiB limit, growing ${values.growthPerMinute.toFixed(0)} MiB per minute.`,
      values.timeToLimit > 0
        ? `At this slope it reaches the limit in about ${Math.round(values.timeToLimit)} seconds. The slope, not the current percentage, is the early warning.`
        : "The task is not growing in this configuration, so the limit is not a countdown.",
      values.oomCount > 0
        ? `${values.oomCount} OOM kill(s) have occurred. Each restart resets usage to ${Math.round(values.baseline)} MiB and repeats the same path.`
        : "No OOM kill has occurred in this window.",
      "Exit code 137 is 128 plus signal 9. It proves SIGKILL, not the reason; the stop reason and memory curve supply the cause.",
      "CPU throttling reduces CPU time and leaves the process running. It does not produce an OOM stop reason.",
    ];
  },
  legend: [
    { label: "Below the limit", tone: "ok" },
    { label: "Approaching the limit", tone: "warn" },
    { label: "OOM killed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 1,024 MiB limit, 400 MiB baseline, and 20 MiB/min growth that stays under the ceiling.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Growing fast",
    description: "A 1,024 MiB limit with 700 MiB baseline and 96 MiB/min growth. The limit is about three minutes away.",
    tone: "warn",
    params: defaults({ memoryLimitMiB: 1_024, baselineUsageMiB: 700, growthMiBPerMinute: 80, trafficMultiplier: 1.2 }),
  },
  {
    id: "failure",
    label: "OOM loop",
    description: "A 512 MiB limit with 400 MiB baseline and 360 MiB/min growth kills the task in under 20 seconds.",
    tone: "crit",
    elapsed: 30,
    params: defaults({ memoryLimitMiB: 512, baselineUsageMiB: 400, growthMiBPerMinute: 240, trafficMultiplier: 1.5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Growth falls to 10 MiB/min under a 1,024 MiB limit, leaving the task far below the ceiling.",
    tone: "ok",
    elapsed: 10,
    params: defaults({ memoryLimitMiB: 1_024, baselineUsageMiB: 450, growthMiBPerMinute: 10, trafficMultiplier: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-exit-137",
  title: "Predict what exit code 137 proves",
  simId: "oom-kills",
  question:
    "A task stopped with exit code 137. CPU throttling was above 20% that hour. What does the exit code prove about the cause?",
  prediction: {
    options: [
      { id: "oom", label: "It proves the kernel OOM killer acted" },
      { id: "cpu", label: "It proves CPU throttling killed the task" },
      { id: "sigkill", label: "It proves SIGKILL, which can be OOM or another kill, so check stop reason and memory" },
      { id: "normal", label: "It proves the application exited normally" },
    ],
    correctOptionId: "sigkill",
    explanation:
      "Exit code 137 is 128 plus signal 9, so it reports SIGKILL. The OOM killer is a common cause, but a manual kill, an agent action, or the runtime can also send SIGKILL. The memory curve and the stopped task reason separate an OOM kill from the alternatives. CPU throttling does not send SIGKILL; it reduces CPU time and leaves the task running.",
  },
  setup: defaults({ memoryLimitMiB: 512, baselineUsageMiB: 400, growthMiBPerMinute: 240, trafficMultiplier: 1.5 }),
  runFor: 45,
  observe: [
    "Memory climbs from 400 MiB to the 512 MiB limit in under 20 seconds.",
    "The task stops with exit 137 and a memory-related stop reason, then restarts at baseline.",
    "The growth rate and the slope repeat after each restart, so the next kill is predictable.",
    "A 1,024 MiB limit with low growth keeps the task below the ceiling and out of the loop.",
  ],
  explain:
    "An OOM kill is visible in three places that agree: the memory series crosses the limit, the stopped task reason names memory, and the exit code is 137. Exit code alone is ambiguous. The restart loop is the trap: the service appears available between kills, so a dashboard that only counts running tasks can miss it. Graph memory across restarts and compare the value at the same point in each cycle.",
  fix: defaults({ memoryLimitMiB: 1_024, baselineUsageMiB: 450, growthMiBPerMinute: 10, trafficMultiplier: 1 }),
  debrief:
    "With growth controlled, the task stays below the limit and the OOM count stops rising. The tradeoff is that a larger limit and slower growth both cost something: more memory reserved per task, or engineering work to find the retained allocation. Raising the limit alone would buy time but not remove the slope, so the kill would return later with the same shape.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An out-of-memory (OOM) kill happens when a task cannot keep its memory usage below a hard limit. The kernel tries to reclaim pages, fails, and invokes the OOM killer. The selected process receives SIGKILL, which cannot be caught or ignored. On Linux, the shell reports that as exit code 137: 128 plus signal 9.",
  },
  {
    type: "p",
    text: "Amazon Elastic Container Service (ECS) reports a stopped task reason alongside the exit code. A memory kill commonly carries a reason such as OutOfMemoryError: Container killed due to memory usage. That reason is more specific than 137, but it is still evidence to correlate with the memory curve, not a substitute for it. A task can be killed for memory while the node has free memory, because the limit belongs to the task's control group.",
  },
  {
    type: "table",
    headers: ["Signal", "What it shows", "What it cannot show alone"],
    rows: [
      ["Exit code 137", "The process received SIGKILL", "Who sent it or why"],
      ["Stop reason", "The runtime's account of the stop", "The memory trend before the stop"],
      ["Memory series", "Usage and slope before the kill", "Which allocation retained the memory"],
      ["Restart count", "How often the cycle repeats", "Whether the cause changed between cycles"],
      ["CPU throttling", "CPU time was capped", "A reason for SIGKILL"],
    ],
  },
  {
    type: "p",
    text: "CPU throttling is the common false lead. A throttled task receives less CPU time and slows down, but it keeps running. It does not get SIGKILL and does not produce a memory stop reason. If both signals are present, the memory curve decides whether the stop was an OOM kill; the throttling may be a separate performance problem.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The memory limit lives in the task definition and is enforced by the Linux control group for the task. Memory metrics come from the container runtime and from the application's own heap or allocator. The ECS agent observes the stop reason and the exit code. The service scheduler then starts a replacement, which resets the process and its memory to baseline.",
  },
  {
    type: "p",
    text: "That reset is why OOM loops are easy to miss. The service can reach its desired count between kills, the replacement can pass its health check, and the only durable evidence is the stop reason, the restart count, and a memory graph that survives the restart. A dashboard that shows only current memory looks healthy right after each replacement.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Memory pressure climbing toward the hard limit, with a sawtooth across restarts.",
      "The growth rate in MiB per minute, which is the early warning before the ceiling.",
      "OOM kill count and the time from restart to the next kill.",
      "A stop record showing exit 137 and a memory-related reason, separate from CPU throttling.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Growing fast to watch the time to the limit shrink. Apply OOM loop to see kills, restarts, and a repeating slope. Apply Recovery to remove the growth and leave the task below its limit. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "oom-kills" },
  { type: "experiment", experimentId: "predict-exit-137" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The OOM loop preset started at 400 MiB under a 512 MiB limit and grew 360 MiB per minute. It reached the limit in under 20 seconds, was killed with SIGKILL, and restarted at baseline. The second cycle followed the same path, so the kill count rose and the service kept replacing a task that was never going to stay under the limit.",
  },
  {
    type: "p",
    text: "The recovery preset lowered growth to 10 MiB per minute under a 1,024 MiB limit. The task stayed far below the ceiling, the kill count stopped rising, and the slope no longer predicted a near-term stop. The limit changed, but the important change was the slope.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A stopped task reason that names memory and an exit code of 137.",
      "A memory graph with a rising slope and a sawtooth reset at each restart.",
      "Restart counts or task replacement events at a regular interval.",
      "CPU throttling present at the same time, which is a separate signal and not the cause of a SIGKILL.",
      "Heap or allocation profiles that differ from the baseline after the same amount of traffic.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the stopped task reason and exit code, then graph memory before the stop. Compare the shape across restarts. If the slope is persistent, look for retained allocations; if the ceiling is flat and immediate, check whether the limit is simply below the task's real working set. Do not start by raising the limit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the stop reason, exit code, and memory series before the replacement starts.",
      "Measure the slope at constant traffic and compare it across restarts.",
      "Find the retained allocation, unbounded cache, or buffer that grows with time or volume.",
      "If the workload is legitimate, raise the limit and verify node placement.",
      "Add an alert on the slope or time to limit, not only on the ceiling.",
      "Re-test long enough to cover the previous time to failure.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher memory limit prevents the kill and reserves more capacity per task.",
      "A restart-based remediation restores availability briefly and hides the trend if memory is not graphed across restarts.",
      "Aggressive memory alerts catch growth early and can page on normal startup allocation.",
      "Heap profiling finds the leak and adds overhead and operational work.",
      "Caching more data improves latency and raises the working set that must fit under the limit.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "exit-137",
    question:
      "A task restarts with exit code 137. Walk me through how you decide whether it was memory or CPU.",
    difficulty: 2,
    hints: [
      "137 is SIGKILL, not a CPU signal.",
      "The stop reason and memory curve are separate evidence.",
    ],
    answer:
      "I would start with the stopped task reason, then graph memory before the stop. If the reason names memory and the memory series crosses the task limit, it is an OOM kill. If the memory curve is flat and the stop reason is something else, 137 may have another cause, because it only proves SIGKILL. CPU throttling is a separate check: a throttled task loses CPU time and slows down, but it is not killed for CPU. I would also compare the timing with deployments, manual actions, and node pressure so I do not force the evidence to fit the first hypothesis.",
    followUps: [
      "What if the stop reason is missing?",
      "How would you distinguish a leak from a one-time spike?",
      "Why can the node have free memory and still OOM-kill the task?",
    ],
    redFlags: [
      "Assumes 137 always means OOM.",
      "Blames CPU throttling for a SIGKILL.",
      "Looks only at current memory after the restart.",
    ],
    rubric: [
      "Reads stop reason and exit code together.",
      "Checks memory before the stop.",
      "Separates CPU throttling from kills.",
      "Considers alternative SIGKILL causes.",
    ],
  },
  {
    id: "oom-loop",
    question:
      "A service is available but one task restarts every 20 minutes. How do you prove it is an OOM loop?",
    difficulty: 3,
    hints: [
      "Current memory looks healthy right after each restart.",
      "The interval and the slope are the durable evidence.",
    ],
    answer:
      "I would align the restart times with memory and stop-reason events over several cycles. An OOM loop shows a sawtooth: memory rises from the same baseline to the limit, the task stops with a memory reason and 137, and the replacement repeats the slope. The service can still look available because the replacement happens before the desired count is visibly affected. I would graph memory over a window long enough to include at least two cycles, compare the value at the same point after each restart, and check whether request volume explains the slope. A single current-memory sample after a restart is misleading.",
    followUps: [
      "Which alert would catch this before the first user impact?",
      "How would a traffic change alter the interval?",
      "When would raising the limit be the right fix?",
    ],
    redFlags: [
      "Trusts current memory after a restart.",
      "Raises the limit without looking at the slope.",
      "Counts running tasks as proof of health.",
    ],
    rubric: [
      "Uses multiple cycles.",
      "Identifies the sawtooth pattern.",
      "Separates baseline, slope, and limit.",
      "Chooses a durable alert.",
    ],
  },
  {
    id: "leak-vs-limit",
    question:
      "How do you tell an undersized memory limit from a memory leak?",
    difficulty: 3,
    hints: [
      "One shape is flat near the ceiling; the other keeps rising.",
      "A restart resets the process, not the code path.",
    ],
    answer:
      "I would look at the shape over time and across restarts. An undersized limit produces a working set that is stable but close to or above the ceiling, often immediately after startup, and raising the limit removes the kill without changing the trend. A leak produces a persistent slope: memory rises at a similar rate after each restart, and the time to the limit is predictable. I would compare heap or allocation profiles at the same traffic level, check whether growth tracks requests or elapsed time, and verify the fix over a window longer than the previous time to failure. The limit change is not a diagnosis.",
    followUps: [
      "What would you measure if the slope only appears under load?",
      "How does a cache eviction policy change the shape?",
      "What is the risk of setting the limit from the peak?",
    ],
    redFlags: [
      "Raises the limit without checking the shape.",
      "Assumes every slope is a leak.",
      "Tests for less time than the failure interval.",
    ],
    rubric: [
      "Distinguishes flat ceiling from rising slope.",
      "Uses profiles and traffic correlation.",
      "Verifies over a sufficient window.",
      "Treats the limit as separate from the cause.",
    ],
  },
];

const checklist = [
  {
    title: "Before the task ships",
    items: [
      "The memory limit is based on a measured working set and growth under load.",
      "The application exposes heap or allocation metrics that survive a restart.",
      "An alert exists on memory slope or time to limit, not only on the ceiling.",
      "The service replacement behavior is understood, including how quickly a killed task is replaced.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Read the stopped task reason and exit code together.",
      "Graph memory before the stop, not only after the replacement.",
      "Compare the interval between restarts with time to reach the limit.",
      "Check CPU throttling separately; it does not explain a SIGKILL.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Capture a profile at the same traffic level as the failure.",
      "Fix or bound the retained allocation.",
      "If the limit must change, verify node placement and neighbor impact.",
      "Re-test for longer than the previous time to failure.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task stop reasons",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-stop-reasons.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Stopped task reasons, including out-of-memory stops and the exit codes ECS reports.",
  },
  {
    title: "Amazon ECS task definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Task and container memory limits, reservations, and CPU settings.",
  },
  {
    title: "Linux control group v2 memory controller",
    url: "https://docs.kernel.org/admin-guide/cgroup-v2.html",
    publisher: "The Linux Kernel documentation",
    kind: "docs" as const,
    note: "Memory limits, reclaim, and OOM behavior in cgroup v2.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "oom-kills": {
      model: oomModel,
      presets,
      instructions:
        "Start Healthy, then apply Growing fast and OOM loop. Watch the memory slope and the restart cycle, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 8-second restart, 20-second kill alert, growth rates, and memory limits are teaching values, not ECS defaults or application benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-cpu-memory-limits",
    "containers-logs",
    "containers-task-definitions",
    "containers-services",
  ],
};
