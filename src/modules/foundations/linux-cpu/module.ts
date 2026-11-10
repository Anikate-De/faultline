import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERVICE_MS = 4;

const params = [
  {
    id: "runnableThreads",
    label: "Runnable threads",
    min: 1,
    max: 64,
    step: 1,
    value: 4,
    unit: "",
    group: "Workload",
    help: "Threads competing for CPU. Includes runnable application work, not threads blocked on I/O.",
    format: "count" as const,
  },
  {
    id: "cores",
    label: "vCPUs",
    min: 2,
    max: 64,
    step: 2,
    value: 8,
    unit: "",
    group: "Host",
    help: "vCPUs the guest sees. This is not the same as the physical capacity the guest actually receives.",
    format: "count" as const,
  },
  {
    id: "steal",
    label: "CPU steal",
    min: 0,
    max: 60,
    step: 1,
    value: 0,
    unit: "%",
    group: "Host",
    help: "Share of each vCPU the hypervisor gives to another guest. The guest cannot run during stolen time.",
    format: "percent" as const,
  },
  {
    id: "iowait",
    label: "I/O-blocked threads",
    min: 0,
    max: 60,
    step: 1,
    value: 2,
    unit: "%",
    group: "Workload",
    help: "Share of threads waiting on I/O. They count in load average but do not consume CPU.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  threads: number;
  cores: number;
  steal: number;
  iowait: number;
  runnable: number;
  availableCores: number;
  runnableExcess: number;
  loadAverage: number;
  guestBusy: number;
  ratio: number;
  p99: number;
}

function compute(p: Params): Computed {
  const threads = Math.max(1, Math.round(num(p, "runnableThreads", 4)));
  const cores = Math.max(1, Math.round(num(p, "cores", 8)));
  const steal = clamp(num(p, "steal", 0) / 100);
  const iowait = clamp(num(p, "iowait", 2) / 100);
  const runnable = threads * (1 - iowait);
  const availableCores = Math.max(0.1, cores * (1 - steal));
  const runnableExcess = Math.max(0, runnable - availableCores);
  const loadAverage = runnable + threads * iowait;
  const guestBusy = (Math.min(runnable, availableCores) / cores) * 100;
  const ratio = runnable / availableCores;
  const p99 =
    Math.min(3_000, SERVICE_MS + (20 * ratio ** 4) / Math.max(0.08, 1.05 - ratio) + iowait * 150);
  return {
    threads,
    cores,
    steal: steal * 100,
    iowait: iowait * 100,
    runnable,
    availableCores,
    runnableExcess,
    loadAverage,
    guestBusy,
    ratio,
    p99,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 5)) / 2.4);
  const seeds: [string, number, number][] = [
    ["guest-cpu", values.guestBusy, 0.3],
    ["runnable", values.runnable, 0.05],
    ["runnable-excess", values.runnableExcess, 0.05],
    ["p99", values.p99, 0.4],
    ["steal", values.steal, 0.2],
    ["iowait", values.iowait, 0.2],
    ["load-average", values.loadAverage, 0.1],
    ["available-cores", values.availableCores, 0.05],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  const cores = Math.max(1, values.cores);
  for (let index = 0; index < cores; index++) {
    const wave = 0.9 + 0.12 * Math.sin((index + seed) / 2.3);
    frame.series[`cpu.core-${index}`] = Array.from({ length: 24 }, (_, point) =>
      Math.max(0, Math.min(100, values.guestBusy * wave + Math.sin(point / 2.6 + index) * 2)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const hostHealth = healthFor(values.p99, 50, 150);
  const stealHealth = healthFor(values.steal, 10, 25);
  const appHealth = hostHealth;
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: appHealth,
        utilization: clamp(values.guestBusy / 100),
        sublabel: `${values.runnable.toFixed(1)} runnable`,
        meta: { view: "flow" },
      },
      {
        id: "neighbor",
        label: "Other guest",
        kind: "external",
        health: stealHealth,
        sublabel: `${values.steal.toFixed(0)}% steal`,
        meta: { view: "flow" },
      },
      {
        id: "host",
        label: "Linux host",
        kind: "service",
        health: hostHealth,
        utilization: clamp(values.guestBusy / 100),
        sublabel: `${values.availableCores.toFixed(1)} of ${values.cores} vCPUs available`,
        detail: `${values.cores} vCPUs, ${values.steal.toFixed(0)}% steal, ${values.runnable.toFixed(1)} runnable (vmstat r), ${values.runnableExcess.toFixed(1)} runnable excess, p99 ${values.p99.toFixed(0)}ms.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-host", "app", "host", values.runnable / values.cores, hostHealth),
      edge("neighbor-host", "neighbor", "host", values.steal / 100, stealHealth),
    ],
    metrics: [
      metric("guest-cpu", "Guest CPU busy", values.guestBusy, "%", 80, 95, "percent"),
      metric("runnable", "Runnable tasks (vmstat r)", values.runnable, " threads", undefined, undefined, "number"),
      metric("runnable-excess", "Runnable excess", values.runnableExcess, " threads", 1, 4, "number"),
      metric("p99", "Request p99", values.p99, "ms", 50, 150, "ms"),
      metric("steal", "CPU steal", values.steal, "%", 10, 25, "percent"),
      metric("iowait", "I/O wait", values.iowait, "%", 10, 25, "percent"),
      metric("load-average", "Load average", values.loadAverage, " tasks", undefined, undefined, "number"),
      metric("available-cores", "Available cores", values.availableCores, " cores", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Guest CPU ${values.guestBusy.toFixed(0)}%; ${values.runnable.toFixed(1)} runnable vs ${values.availableCores.toFixed(1)} available; excess ${values.runnableExcess.toFixed(1)}; p99 ${values.p99.toFixed(0)}ms.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 50,
    crit: 150,
    title: "Request latency is in the CPU queue",
    cause:
      "Runnable work exceeds the CPU capacity the guest actually receives. The guest utilization number can look moderate because it excludes steal or counts only busy time.",
    fix: "Reduce runnable concurrency, move the workload off the contended host, or add capacity. Adding vCPUs does not help if steal is the constraint.",
    checkFirst: [
      "Compare vmstat r (total runnable) with available cores; the excess is the waiting work.",
      "Check steal and per-core utilization.",
      "Check whether the latency is CPU queueing or I/O wait.",
    ],
  },
  {
    id: "steal",
    metricId: "steal",
    warn: 10,
    crit: 25,
    title: "The hypervisor is taking CPU time from the guest",
    cause:
      "Another guest or the host itself is using the physical CPU. The vCPU exists, but the guest cannot run on it during stolen time.",
    fix: "Move the workload to a less contended host, use dedicated tenancy or a larger guaranteed share, or reduce the workload's CPU demand. More vCPUs alone do not remove steal.",
    checkFirst: [
      "Check steal per vCPU over time, not just the current value.",
      "Check whether the neighbor is a batch job with a bursty profile.",
      "Check whether the instance type has a guaranteed CPU share.",
    ],
  },
  {
    id: "runnable-excess",
    metricId: "runnable-excess",
    warn: 1,
    crit: 4,
    title: "Runnable excess is growing",
    cause:
      "Runnable excess is vmstat r minus the cores actually available. vmstat r counts all runnable tasks, including the ones currently running; the excess is the part waiting for CPU. A small excess can absorb a burst, but a persistent one means the host is short of effective capacity.",
    fix: "Reduce concurrency per host or add effective CPU. Watch the excess after the change; if it does not fall, the limit is steal, cgroup throttling, or a single hot thread.",
    checkFirst: [
      "Compare vmstat r with available cores, not total vCPUs.",
      "Check runnable excess per available core and its trend.",
      "Check steal and cgroup CPU throttling.",
    ],
  },
  {
    id: "guest-cpu",
    metricId: "guest-cpu",
    warn: 80,
    crit: 95,
    title: "Guest CPU utilization is high",
    cause:
      "The guest is using most of the CPU it can see. This signal alone does not distinguish useful work from queueing, and it can understate pressure when steal is high.",
    fix: "Correlate with runnable excess and p99 before adding capacity. High utilization with no excess may be efficient; a 60% reading with a persistent excess is saturation.",
    checkFirst: [
      "Check runnable excess and p99 beside utilization.",
      "Check per-core imbalance.",
      "Check whether the busiest thread is doing useful work.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const linuxCpuModel: SimModel = {
  id: "foundations-linux-cpu",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    }
    const jitter = rng.between(-0.05, 0.05);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (let index = 0; index < values.cores; index++) {
      recordSeries(next, `cpu.core-${index}`, values.guestBusy + 2 * Math.sin(frame.t + index));
    }
    if (values.steal >= 25 && frame.flags.stealEvent !== 1) {
      pushEvent(next, {
        id: "steal-detected",
        at: frame.t,
        severity: "crit",
        title: "CPU steal is the missing capacity",
        detail: `${values.steal.toFixed(0)}% of each vCPU is unavailable to the guest. ${values.runnable.toFixed(1)} runnable threads (vmstat r) share ${values.availableCores.toFixed(1)} effective cores, leaving ${values.runnableExcess.toFixed(1)} waiting; p99 is ${values.p99.toFixed(0)}ms while guest CPU reads ${values.guestBusy.toFixed(0)}%.`,
        nodeId: "host",
        metricId: "steal",
      });
      next.flags.stealEvent = 1;
    }
    if (values.steal < 10) next.flags.stealEvent = 0;
    next.flags.paramsKey = key;
    next.summary = `Guest CPU ${values.guestBusy.toFixed(0)}%; ${values.runnable.toFixed(1)} runnable vs ${values.availableCores.toFixed(1)} available; excess ${values.runnableExcess.toFixed(1)}; p99 ${values.p99.toFixed(0)}ms.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The guest sees ${values.cores} vCPUs but only ${values.availableCores.toFixed(1)} are available after ${values.steal.toFixed(0)}% steal.`,
      `${values.runnable.toFixed(1)} runnable tasks (vmstat r) against ${values.availableCores.toFixed(1)} effective cores leave ${values.runnableExcess.toFixed(1)} waiting and p99 at ${values.p99.toFixed(0)}ms.`,
      `Guest CPU busy is ${values.guestBusy.toFixed(0)}%. That equals ${Math.min(values.runnable, values.availableCores).toFixed(1)} busy cores out of ${values.cores}; the missing ${values.steal.toFixed(0)}% is steal, not idle capacity the scheduler can use.`,
      `Load average is ${values.loadAverage.toFixed(1)} and includes ${(values.threads * (values.iowait / 100)).toFixed(1)} I/O-blocked threads that are not competing for CPU.`,
    ];
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
    description: "Four runnable threads on eight vCPUs with no steal.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Six threads and mild steal; latency is at the p99 SLO.",
    tone: "warn",
    params: defaults({ runnableThreads: 6, cores: 8, steal: 15, iowait: 8 }),
  },
  {
    id: "failure",
    label: "Noisy neighbor",
    description: "Seven threads share eight vCPUs, but 40% is stolen. Guest CPU still reads moderate.",
    tone: "crit",
    params: defaults({ runnableThreads: 7, cores: 8, steal: 40, iowait: 10 }),
  },
  {
    id: "recovery",
    label: "Move and add capacity",
    description: "Sixteen vCPUs, low steal, and a small runnable excess.",
    tone: "ok",
    params: defaults({ runnableThreads: 7, cores: 16, steal: 5, iowait: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-cpu-steal",
  title: "Predict why p99 is high at moderate CPU",
  simId: "linux-cpu",
  question:
    "The host shows 60% guest CPU, a load average of 7 on 8 vCPUs, and p99 above 700ms. Which signal explains the latency?",
  prediction: {
    options: [
      { id: "steal", label: "CPU steal is reducing the capacity the guest can use" },
      { id: "threads", label: "The runnable thread count is simply too high for any host" },
      { id: "iowait", label: "I/O wait is consuming the CPU" },
      { id: "memory", label: "Memory pressure is causing the scheduler to stall" },
    ],
    correctOptionId: "steal",
    explanation:
      "The guest has eight vCPUs but 40% of each is stolen, leaving 4.8 effective cores. Those 4.8 cores are fully busy, so guest CPU reads 60% of the eight vCPUs; the missing 40% is steal. About 6.3 runnable tasks (vmstat r) compete for 4.8 cores, leaving 1.5 waiting. Load average includes I/O-blocked threads and looks unremarkable at 7 on 8 vCPUs.",
  },
  setup: defaults({ runnableThreads: 7, cores: 8, steal: 40, iowait: 10 }),
  runFor: 20,
  observe: [
    "Guest CPU stays near 60% while p99 crosses 700ms.",
    "Runnable excess is about 1.5 threads; vmstat r is 6.3 total runnable against 4.8 available cores.",
    "Available cores fall from 8 to 4.8 as steal rises.",
    "The load average includes I/O-blocked threads and can look safe while CPU queueing is real.",
  ],
  explain:
    "Utilization answers how much of the CPU the guest used, not how much it could use. Steal removes capacity before the guest scheduler sees it, so the guest can be at its effective limit while the headline percentage looks moderate. vmstat r counts total runnable tasks; compare it with available cores, and treat the difference as runnable excess. The load average bundles runnable and uninterruptible tasks and needs to be read with both.",
  fix: defaults({ runnableThreads: 7, cores: 16, steal: 5, iowait: 5 }),
  debrief:
    "Moving to a host with less contention and more vCPUs drops p99 below the warning line. Adding vCPUs alone would not help if steal stayed at 40%, because the guest would still receive only a fraction of each new vCPU. The durable fixes are a less contended host, a guaranteed CPU share, or less runnable work per host.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "CPU saturation is not the same as high CPU utilization. A host is saturated when runnable work has to wait for CPU. On Linux, the scheduler keeps a run queue of tasks that are ready to execute. `vmstat` reports that population in the `r` column: total runnable tasks, including the ones currently running. Runnable excess is `r` minus the cores actually available. The excess grows when runnable work exceeds the CPU capacity available to it, and latency follows it, not the utilization percentage.",
  },
  {
    type: "p",
    text: "Two signals make this hard. First, a virtual machine sees vCPUs that the hypervisor may not fully deliver. Time taken by another guest is reported as steal, and the guest's own busy percentage can look moderate while effective capacity is much lower. Second, I/O wait is time the CPU was idle because tasks were blocked on storage. It counts in load average as uninterruptible tasks, but it is not CPU work. A load average of 8 on 8 vCPUs is not automatically healthy or unhealthy until you know what those tasks are doing.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it does", "Pressure signal"],
    rows: [
      ["Application threads", "Submit runnable work to the scheduler", "Runnable count and service time"],
      ["CFS run queue", "Shares available vCPUs among runnable tasks", "vmstat r and runnable excess"],
      ["vCPU", "Executes guest work when the hypervisor schedules it", "Per-core utilization and steal"],
      ["Hypervisor", "Allocates physical CPU among guests", "Steal time and effective cores"],
    ],
  },
  {
    type: "p",
    text: "The path is application threads, the Linux CFS scheduler, the vCPU, and the hypervisor's physical CPU. CFS gives runnable tasks a fair share of the available vCPUs. The hypervisor decides how much physical CPU each vCPU actually receives. Steal is the gap between the two. Inside a container, a CPU quota can also throttle the group even when the host has idle capacity; this model does not include quota throttling, so treat that as a separate check.",
  },
  {
    type: "p",
    text: "The model is illustrative: four-millisecond service time and the latency curve are teaching values, not a benchmark of a specific instance type. The relationships are the lesson. Runnable threads above available cores create a queue; steal reduces available cores; I/O-blocked threads inflate load average without consuming CPU.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Guest CPU busy: what the guest believes it used, excluding steal.",
      "Runnable tasks (vmstat r) and runnable excess: total runnable threads versus the cores actually available.",
      "CPU steal and available cores: the capacity the hypervisor did not deliver.",
      "Load average and I/O wait: tasks that may be blocked rather than runnable.",
      "Request p99: the latency consequence, which is the signal users feel.",
    ],
  },
  {
    type: "table",
    headers: ["Signal", "Answers", "Common misread"],
    rows: [
      ["Guest CPU busy", "How much CPU did the guest use?", "Assumes all vCPUs are fully available"],
      ["vmstat r", "Total runnable tasks", "Includes the tasks currently running"],
      ["Runnable excess", "How many runnable tasks are waiting?", "Averages hide short but repeated waits"],
      ["Load average", "Runnable plus uninterruptible tasks", "Treats I/O-blocked tasks as CPU demand"],
      ["Steal", "Capacity taken by another guest", "Mistaken for idle or normal overhead"],
      ["I/O wait", "CPU idle while tasks wait on I/O", "Mistaken for CPU saturation"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Noisy neighbor. Watch guest CPU read about 60% while p99 crosses 700ms. Raise runnable threads and then steal separately to see which one moves runnable excess. Apply Move and add capacity, then set steal back to 40% to confirm that more vCPUs alone do not fix contention.",
  },
  { type: "sim", simId: "linux-cpu" },
  { type: "experiment", experimentId: "predict-cpu-steal" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The guest had eight vCPUs but received only 4.8 cores of capacity because 40% was stolen. Those 4.8 cores were fully busy, so guest CPU read 60% of the eight vCPUs; the missing 40% was steal, not idle capacity. About 6.3 runnable tasks (vmstat r) competed for 4.8 cores, leaving 1.5 in runnable excess and p99 at several hundred milliseconds.",
  },
  {
    type: "p",
    text: "The load average of 7 looked safe against eight vCPUs, but it included I/O-blocked threads and said nothing about steal. The recovery added vCPUs and reduced contention. If only vCPUs had been added while steal stayed high, each new vCPU would also have been partially stolen and the queue would have persisted.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "vmstat: the `r` column for runnable tasks, `b` for uninterruptible tasks, `wa` for I/O wait, and `st` for steal.",
      "top or pidstat: per-core utilization and the busiest threads, with steal shown separately from user and system time.",
      "Load average from `/proc/loadavg`: useful as a trend, but it mixes runnable and uninterruptible tasks.",
      "Container metrics: CPU throttling (`nr_throttled`, `throttled_time`) when a cgroup quota is the limit.",
      "Traces: latency rises before the application reports CPU saturation, often with a flat throughput plateau.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read vmstat r and steal together. Compare total runnable tasks with available cores, and use runnable excess for the waiting work. Then separate CPU queueing from I/O wait and cgroup throttling before adding capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the queue: vmstat r above available cores, with a persistent runnable excess, or a rising p99 with flat throughput.",
      "Check steal. If it is high, move the workload or obtain a guaranteed CPU share before adding vCPUs.",
      "Check cgroup throttling. A quota can limit the group even when the host is idle.",
      "Reduce runnable concurrency if the work is bursty or the thread pool is oversized.",
      "Add effective capacity only after the queue is understood; verify per-core utilization and p99 together.",
      "Re-check load average with `vmstat` so I/O-blocked tasks are not counted as CPU demand.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More vCPUs raise cost and do not help if steal or a cgroup quota is the real limit.",
      "Reducing concurrency protects latency but can lower throughput if the service was CPU-bound on useful work.",
      "Moving to dedicated capacity costs more but removes a noisy-neighbor failure mode.",
      "A high utilization with no queue can be efficient; treating every high CPU graph as an incident wastes capacity.",
      "Load average is cheap and familiar, but it is a mixed signal. Use it as a trend, not a diagnosis.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-vmstat",
    question:
      "A host has 8 vCPUs, load average 7, 55% CPU busy, and p99 latency rising. How do you decide whether it is CPU saturation?",
    difficulty: 2,
    hints: [
      "Load average is not the same as runnable CPU demand.",
      "Check vmstat r, runnable excess, and steal before adding capacity.",
    ],
    answer:
      "I would check vmstat r, runnable excess, and steal first, not the load average alone. `r` is total runnable (running plus waiting); compare it with available cores. If `r` is persistently above the number of available cores, the difference is runnable excess, which means work is waiting. If `st` is high, the guest is not receiving the vCPUs it sees, so effective capacity is lower than the headline count. I would also check `wa` to separate I/O-blocked tasks and cgroup throttling to rule out a quota. A load average of 7 on 8 vCPUs can be healthy if most tasks are uninterruptible I/O, or unhealthy if 7 tasks are runnable on 4.8 effective cores.",
    followUps: [
      "What would you check if runnable excess is low but p99 is high?",
      "How does cgroup CPU throttling appear?",
      "Which fix would you try first?",
    ],
    redFlags: [
      "Adds vCPUs based on load average alone.",
      "Treats iowait as CPU busy.",
      "Ignores steal.",
    ],
    rubric: [
      "Reads vmstat r against available cores and computes the excess.",
      "Separates steal and iowait.",
      "Checks cgroup throttling.",
      "Ties the fix to the limiting resource.",
    ],
  },
  {
    id: "steal-vs-load",
    question:
      "Why can a guest report moderate CPU utilization while its requests queue for hundreds of milliseconds?",
    difficulty: 3,
    hints: [
      "Utilization is measured from the guest's point of view.",
      "The hypervisor can take time before the guest scheduler runs.",
    ],
    answer:
      "Guest utilization counts time the guest actually ran, so stolen time does not appear as guest busy. If the hypervisor takes 40% of each vCPU, eight vCPUs deliver 4.8 cores of capacity. If those cores are fully busy, guest CPU reads 60% of the eight vCPUs. Runnable tasks above 4.8 wait as runnable excess even though the guest percentage looks moderate. The missing signals are steal and vmstat r relative to available cores. Adding vCPUs without removing steal just creates more partially available vCPUs.",
    followUps: [
      "How would you prove steal is the cause?",
      "What instance or tenancy change would remove it?",
      "Can steal be caused by the guest's own I/O?",
    ],
    redFlags: [
      "Says utilization is the only CPU signal.",
      "Blames the application without checking the host.",
      "Believes more vCPUs always add proportional capacity.",
    ],
    rubric: [
      "Explains guest-visible utilization.",
      "Quantifies effective cores.",
      "Names runnable excess as the pressure signal.",
      "Distinguishes capacity from vCPU count.",
    ],
  },
  {
    id: "iowait-misread",
    question:
      "A dashboard shows 30% iowait and the team wants to add CPU. What is wrong with that response?",
    difficulty: 2,
    hints: [
      "Iowait is idle CPU time, not busy CPU time.",
      "The bottleneck may be storage latency.",
    ],
    answer:
      "Iowait means the CPU was idle while tasks waited for I/O. Adding CPU does not make the storage faster and may increase concurrency against an already slow device. I would check disk latency, queue depth, and the application's I/O pattern first. CPU may still be a secondary constraint, but iowait is evidence for an I/O bottleneck, not CPU saturation.",
    followUps: [
      "Which disk metrics would you check?",
      "When can iowait be high without a storage problem?",
      "How would you confirm the fix?",
    ],
    redFlags: [
      "Treats iowait as CPU utilization.",
      "Adds CPU without checking storage.",
      "Ignores queue depth.",
    ],
    rubric: [
      "Defines iowait correctly.",
      "Points to storage as the likely limit.",
      "Names the confirming metrics.",
    ],
  },
  {
    id: "concurrency-fix",
    question:
      "Runnable excess is high because the service runs 64 worker threads on 8 vCPUs. What happens if you lower the pool to 16, and what is the risk?",
    difficulty: 3,
    hints: [
      "Threads above available cores add queueing, not throughput.",
      "Some threads may be blocked on I/O or upstream calls.",
    ],
    answer:
      "Lowering the pool reduces runnable concurrency and runnable excess, which usually improves p99 when the work is CPU-bound. The risk is that some of those threads were blocked on I/O or upstream calls, so reducing the pool can lower throughput or cause request timeouts. I would measure the runnable-to-blocked ratio and the service time first, then change the pool gradually and watch throughput, p99, and runnable excess together.",
    followUps: [
      "How would you size the pool from Little's Law?",
      "What if the threads are mostly blocked?",
      "How would a cgroup CPU quota change the answer?",
    ],
    redFlags: [
      "Assumes all threads are CPU-bound.",
      "Cuts the pool without measuring throughput.",
      "Ignores blocked threads.",
    ],
    rubric: [
      "Links concurrency to runnable excess.",
      "Names the throughput risk.",
      "Proposes a measured rollout.",
      "Considers blocked work.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show vmstat r, runnable excess, steal, iowait, and per-core utilization, not only CPU percentage.",
      "The service's runnable concurrency and thread-pool size are known.",
      "Cgroup CPU throttling is monitored where quotas are used.",
      "Hosts with a history of steal have a documented migration path.",
      "Load average is interpreted with the runnable and uninterruptible split.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare vmstat r with available cores, not total vCPUs, and graph runnable excess.",
      "Check steal before adding capacity.",
      "Separate I/O wait from CPU queueing.",
      "Check whether a cgroup quota is throttling the group.",
      "Watch p99 and throughput together after any change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record whether the fix removed the queue or only moved it.",
      "Review thread-pool sizing against measured service time.",
      "Add a steal alert if the host class is shared.",
      "Re-test the workload at peak with the new capacity.",
    ],
  },
];

const references = [
  {
    title: "CFS Scheduler",
    url: "https://docs.kernel.org/scheduler/sched-design-CFS.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "The completely fair scheduler and runnable task accounting.",
  },
  {
    title: "vmstat(8)",
    url: "https://man7.org/linux/man-pages/man8/vmstat.8.html",
    publisher: "Linux man-pages",
    kind: "docs" as const,
    note: "Runnable tasks, blocked tasks, I/O wait, and steal columns.",
  },
  {
    title: "The USE Method",
    url: "https://www.brendangregg.com/usemethod.html",
    publisher: "Brendan Gregg",
    kind: "docs" as const,
    note: "Utilization, saturation, and errors for CPU and other resources.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "linux-cpu": {
      model: linuxCpuModel,
      presets,
      instructions:
        "Start healthy, then compare more runnable threads with more steal. Read vmstat r, runnable excess, and available cores together; guest CPU alone will not explain the latency.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. Service time and the latency curve are teaching values; steal and runnable excess are the causal signals.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-littles-law", "foundations-queueing-knee", "foundations-linux-memory"],
};
