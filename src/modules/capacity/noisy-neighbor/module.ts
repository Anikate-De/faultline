import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INTERACTIVE_CORES = 14;
const BASE_P99 = 45;
const BATCH_BASELINE = 4;
const RAMP_START = 4;
const RAMP_END = 26;

const params = [
  {
    id: "poolCores",
    label: "Shared pool size",
    min: 16,
    max: 96,
    step: 4,
    value: 48,
    unit: " cores",
    group: "Shared pool",
    help: "Total CPU reserved for both tenants. One core is an abstract unit of compute, not an instance type. Illustrative.",
    format: "count" as const,
  },
  {
    id: "batchDemand",
    label: "Batch tenant demand",
    min: 2,
    max: 96,
    step: 2,
    value: 24,
    unit: " cores",
    group: "Batch tenant",
    help: "CPU the batch tenant wants at its peak. The model ramps from 4 cores to this value over about 22 simulated seconds.",
    format: "count" as const,
  },
  {
    id: "tenantQuota",
    label: "Per-tenant CPU quota",
    min: 20,
    max: 100,
    step: 5,
    value: 100,
    unit: "% of pool",
    group: "Isolation",
    help: "Maximum share of the pool any one tenant may consume. 100% means no quota.",
    format: "percent" as const,
  },
  {
    id: "reservedInteractive",
    label: "Reserved for interactive",
    min: 0,
    max: 60,
    step: 5,
    value: 20,
    unit: "% of pool",
    group: "Isolation",
    help: "Capacity the batch tenant cannot take even when the pool is idle. A reservation protects latency and strands capacity.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function batchAt(p: Params, t: number): number {
  const target = Math.max(2, num(p, "batchDemand", 24));
  const start = Math.min(BATCH_BASELINE, target);
  const progress = smoothstep((t - RAMP_START) / (RAMP_END - RAMP_START));
  return start + (target - start) * progress;
}

interface Computed {
  pool: number;
  batchDemand: number;
  batchServed: number;
  throttled: number;
  quotaCap: number;
  reservedCap: number;
  remaining: number;
  utilization: number;
  poolUtilization: number;
  shed: number;
  errors: number;
  p99: number;
}

function compute(p: Params, t: number): Computed {
  const pool = Math.max(8, num(p, "poolCores", 48));
  const batchDemand = batchAt(p, t);
  const quotaFrac = clamp(num(p, "tenantQuota", 100) / 100, 0.05, 1);
  const reservedFrac = clamp(num(p, "reservedInteractive", 20) / 100, 0, 0.9);
  const quotaCap = pool * quotaFrac;
  const reservedCap = pool * (1 - reservedFrac);
  const batchCap = Math.max(0, Math.min(quotaCap, reservedCap));
  const batchServed = Math.min(batchDemand, batchCap);
  const throttled = Math.max(0, batchDemand - batchServed);
  const remaining = Math.max(0.4, pool - batchServed);
  const utilization = INTERACTIVE_CORES / remaining;
  const shed = Math.max(0, INTERACTIVE_CORES - remaining);
  const errors = shed > 0 ? (shed / INTERACTIVE_CORES) * 100 : 0.02;
  const p99 =
    utilization <= 1
      ? BASE_P99 + (70 * utilization) / Math.max(0.02, 1 - utilization)
      : Math.min(15_000, 3_000 + (utilization - 1) * 1_000);
  return {
    pool,
    batchDemand,
    batchServed,
    throttled,
    quotaCap,
    reservedCap,
    remaining,
    utilization,
    poolUtilization: ((INTERACTIVE_CORES + batchServed) / pool) * 100,
    shed,
    errors,
    p99,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.p99 >= 800 || values.errors >= 5) return "crit";
  if (values.p99 >= 300 || values.poolUtilization >= 90) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.6);
  const entries: [string, number, number][] = [
    ["interactive-p99", values.p99, 8],
    ["interactive-errors", values.errors, 0.08],
    ["pool-utilization", values.poolUtilization, 1.2],
    ["batch-served", values.batchServed, 0.4],
    ["batch-throttled", values.throttled, 0.4],
    ["interactive-capacity", values.remaining, 0.3],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number, state: { burst: boolean; throttled: boolean }): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v);
  return {
    t: 0,
    nodes: [
      {
        id: "interactive",
        label: "Interactive tenant",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(v.utilization),
        throughput: Math.min(INTERACTIVE_CORES, v.remaining),
        capacity: v.remaining,
        sublabel: `${INTERACTIVE_CORES} cores · p99 ${v.p99.toFixed(0)}ms`,
        detail: `Interactive requests need ${INTERACTIVE_CORES} cores and have ${v.remaining.toFixed(1)} cores available. Batch traffic took the rest of the shared pool.`,
        meta: { view: "flow" },
      },
      {
        id: "batch",
        label: "Batch tenant",
        kind: "worker",
        health: "ok",
        utilization: clamp(v.batchServed / Math.max(1, v.batchDemand)),
        throughput: v.batchServed,
        capacity: v.batchDemand,
        sublabel: `${v.batchServed.toFixed(0)} of ${v.batchDemand.toFixed(0)} cores`,
        detail: `The batch tenant is served ${v.batchServed.toFixed(1)} cores and throttled ${v.throttled.toFixed(1)} cores by the quota or reservation.`,
        meta: { view: "flow" },
      },
      {
        id: "pool",
        label: "Shared compute pool",
        kind: "service",
        health,
        utilization: clamp(v.poolUtilization / 100),
        throughput: INTERACTIVE_CORES + v.batchServed,
        capacity: v.pool,
        sublabel: `${v.poolUtilization.toFixed(0)}% allocated`,
        detail: `${v.pool} cores shared by both tenants. ${v.batchServed.toFixed(1)} cores go to batch, leaving ${v.remaining.toFixed(1)} for interactive work.`,
        meta: { view: "flow" },
      },
      {
        id: "database",
        label: "Tenant database",
        kind: "db",
        health: "ok",
        utilization: clamp((INTERACTIVE_CORES + v.batchServed) / 120),
        throughput: INTERACTIVE_CORES + v.batchServed,
        sublabel: "shared reads and writes",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("interactive-pool", "interactive", "pool", clamp(INTERACTIVE_CORES / v.pool), health),
      edge("batch-pool", "batch", "pool", clamp(v.batchServed / v.pool), v.throttled > 0 ? "warn" : "ok"),
      edge("pool-database", "pool", "database", clamp((INTERACTIVE_CORES + v.batchServed) / 120), "ok"),
    ],
    metrics: [
      metric("interactive-p99", "Interactive p99", v.p99, " ms", 300, 800, "ms"),
      metric("interactive-errors", "Interactive error rate", v.errors, "%", 1, 5, "percent"),
      metric("pool-utilization", "Shared pool utilization", v.poolUtilization, "%", 90, 97, "percent"),
      metric("interactive-capacity", "Cores left for interactive", v.remaining, " cores", undefined, undefined, "number"),
      metric("batch-served", "Batch tenant served", v.batchServed, " cores", undefined, undefined, "number"),
      metric("batch-throttled", "Batch tenant throttled", v.throttled, " cores", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      burst: state.burst ? 1 : 0,
      throttled: state.throttled ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${v.pool} cores shared: ${v.batchServed.toFixed(0)} to batch, ${v.remaining.toFixed(0)} left for ${INTERACTIVE_CORES} interactive cores. p99 ${v.p99.toFixed(0)}ms, ${v.errors.toFixed(1)}% errors. Illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0, { burst: false, throttled: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "interactive-p99",
    metricId: "interactive-p99",
    warn: 300,
    crit: 800,
    title: "Interactive latency follows the shared pool",
    cause:
      "The batch tenant is consuming cores that interactive requests need. As the capacity left for interactive work shrinks, its queueing delay rises faster than the pool's average utilization suggests.",
    fix:
      "Cap the batch tenant with a quota, reserve a share of the pool for interactive work, or move batch to a separate pool. Adding retries to interactive requests makes the contention worse.",
    checkFirst: [
      "Compare per-tenant CPU consumption with per-tenant latency on one timeline.",
      "Check whether the shared pool is throttling the batch tenant or merely busy.",
      "Compare the batch job's start time with the first rise in interactive p99.",
    ],
  },
  {
    id: "interactive-errors",
    metricId: "interactive-errors",
    warn: 1,
    crit: 5,
    title: "Interactive requests are being rejected",
    cause:
      "Batch work has taken enough of the pool that interactive demand no longer fits in the remaining capacity. The measurement is a direct user impact, not a resource symptom.",
    fix:
      "Restore an interactive capacity floor now, by throttling batch or moving it off the pool. Then set a quota or reservation so the next batch burst cannot cross the floor.",
    checkFirst: [
      "Check whether errors are local rejections, timeouts, or dependency failures.",
      "Check whether the batch tenant is still receiving new work.",
      "Check whether autoscaling is adding pool capacity and whether it can keep up.",
    ],
  },
  {
    id: "pool-utilization",
    metricId: "pool-utilization",
    warn: 90,
    crit: 97,
    title: "The shared pool has no slack",
    cause:
      "Both tenants together are consuming nearly every core. High utilization is efficient on average and dangerous at the margin: the next burst has no room and any latency-sensitive work queues.",
    fix:
      "Decide which tenant may use the last cores. A quota preserves sharing; a reservation or a separate pool preserves latency. Do not simply add capacity unless the cost is justified for both tenants.",
    checkFirst: [
      "Split pool utilization by tenant, not just the total.",
      "Check the batch job's concurrency against its quota.",
      "Check whether the pool has headroom for one failed node or one zone.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const noisyNeighborModel: SimModel = {
  id: "capacity-noisy-neighbor",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p, t);
    const burst = frame.flags.burst === 1 || values.batchDemand > BATCH_BASELINE * 1.05;
    const throttled = frame.flags.throttled === 1 || values.throttled >= 1;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t, { burst, throttled });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (burst && frame.flags.burst !== 1) {
      pushEvent(next, {
        id: "batch-burst",
        at: t,
        severity: "info",
        title: "Batch tenant demand is rising",
        detail: `The batch tenant is ramping toward ${values.batchDemand.toFixed(0)} cores in a pool of ${values.pool.toFixed(0)}. The interactive tenant needs ${INTERACTIVE_CORES} cores.`,
        nodeId: "batch",
        metricId: "batch-served",
      });
    }
    if (throttled && frame.flags.throttled !== 1) {
      pushEvent(next, {
        id: "tenant-throttled",
        at: t,
        severity: "info",
        title: "A quota or reservation is containing the batch tenant",
        detail: `Batch is served ${values.batchServed.toFixed(1)} cores and throttled ${values.throttled.toFixed(1)}. That protects interactive capacity and extends the batch job's run time.`,
        nodeId: "batch",
        metricId: "batch-throttled",
      });
    }

    next.flags.burst = burst ? 1 : 0;
    next.flags.throttled = throttled ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `The pool is ${value("pool-utilization").toFixed(0)}% allocated; ${value("interactive-capacity").toFixed(1)} cores remain for ${INTERACTIVE_CORES} interactive cores.`,
    ];
    if (value("interactive-p99") >= 300) {
      items.push(
        `Interactive p99 is ${value("interactive-p99").toFixed(0)}ms while batch is throttled ${value("batch-throttled").toFixed(1)} cores. Shared utilization hides which tenant is causing the wait.`,
      );
    }
    items.push(
      "A quota limits each tenant's share; a reservation protects one class even when the pool is idle; separate pools remove the shared failure mode and strand the most capacity.",
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
    description: "A 48-core pool, a 20% interactive reservation, and batch demand that fits.",
    tone: "ok",
    params: defaults({ poolCores: 48, batchDemand: 18, tenantQuota: 100, reservedInteractive: 20 }),
  },
  {
    id: "peak",
    label: "Batch peak",
    description: "Batch demand rises to 31 cores; interactive p99 crosses the warning line but still serves.",
    tone: "warn",
    params: defaults({ poolCores: 48, batchDemand: 31, tenantQuota: 90, reservedInteractive: 15 }),
  },
  {
    id: "failure",
    label: "The noisy neighbor",
    description: "A 48-core batch job meets a 32-core pool with no quota or reservation.",
    tone: "crit",
    params: defaults({ poolCores: 32, batchDemand: 48, tenantQuota: 100, reservedInteractive: 0 }),
  },
  {
    id: "quota",
    label: "Quota only",
    description: "A 60% tenant quota keeps batch from taking the pool; interactive stays healthy while batch runs longer.",
    tone: "ok",
    params: defaults({ poolCores: 48, batchDemand: 48, tenantQuota: 60, reservedInteractive: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A larger pool, a 60% quota, and a 35% reservation restore interactive latency.",
    tone: "ok",
    params: defaults({ poolCores: 64, batchDemand: 48, tenantQuota: 60, reservedInteractive: 35 }),
  },
];

const experiment: Experiment = {
  id: "predict-isolation-lever",
  title: "Predict which isolation lever saves interactive latency",
  simId: "noisy-neighbor",
  question:
    "A 48-core batch job runs in a 32-core shared pool with no quota. Interactive p99 is climbing. Which change restores interactive latency?",
  prediction: {
    options: [
      { id: "quota", label: "Raise the batch tenant's quota to 100%" },
      { id: "retry", label: "Add retries to interactive requests" },
      { id: "separate", label: "Move the batch tenant to its own pool" },
      { id: "reserve", label: "Reserve 40% of the same pool for interactive" },
    ],
    correctOptionId: "separate",
    explanation:
      "The batch tenant is already unquotaed, so raising the quota changes nothing. Retries add load to an already saturated pool. A 40% reservation still leaves 19.2 cores for batch in a 32-core pool, so interactive drops below its 14-core requirement. Only removing batch from the pool gives interactive the full 32 cores. A quota low enough to leave the 14-core requirement, around 40%, would also work, but the option list offers a reservation that is too small.",
  },
  setup: defaults({ poolCores: 32, batchDemand: 48, tenantQuota: 100, reservedInteractive: 0 }),
  runFor: 40,
  observe: [
    "Batch demand ramps from 4 to 48 cores while the pool stays at 32.",
    "By about 18 seconds, batch has taken more than 29 cores and interactive p99 crosses 800ms.",
    "Interactive errors appear when the remaining capacity falls below its 14-core requirement.",
    "The pool reports high utilization the whole time, but utilization alone does not identify the tenant causing the wait.",
  ],
  explain:
    "A shared pool is efficient because idle capacity can move between tenants. The same property lets one tenant's burst consume the margin that another tenant's latency depends on. A quota caps the aggressor; a reservation protects the victim even when the aggressor is under quota; a separate pool removes the coupling. Each step reduces the utilization benefit that made the shared pool attractive.",
  fix: defaults({ poolCores: 32, batchDemand: 2, tenantQuota: 100, reservedInteractive: 0 }),
  debrief:
    "With batch moved off the pool, interactive uses 14 of 32 cores at about 44% utilization and p99 returns near 100ms. The batch job now pays for its own capacity, which is the point: the shared pool was cheap only while one tenant's burst could borrow the other's margin.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A noisy neighbor is a tenant whose work consumes a shared resource that another tenant depends on. The usual resource is CPU, but memory bandwidth, connection pools, disk IOPS, and database sessions produce the same shape. The mechanism is not malice. The batch tenant is behaving as configured; the shared pool simply has no rule that says how much of it one tenant may take.",
  },
  {
    type: "p",
    text: "There are three levers. A quota caps one tenant's share of the pool. A reservation protects a share for another tenant even when the first is under quota. Separate pools remove the shared resource entirely. Each lever trades utilization for predictability. A pool that is 100% allocated is efficient on average and fragile at the margin, because the next burst has nowhere to go.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is tenant request, shared compute pool, and tenant data store. Both tenants schedule work onto the same pool. The scheduler enforces quotas and reservations; the application does not see them. The load balancer still routes interactive requests, and the database still serves both tenants, so a CPU contention incident can look like a database problem once retries and queueing reach it.",
  },
  {
    type: "table",
    headers: ["Lever", "What it guarantees", "What it costs", "Failure it leaves"],
    rows: [
      ["Per-tenant quota", "One tenant cannot exceed its share", "Aggressor runs slower; pool may sit partly idle", "Quota set above the safe interactive floor"],
      ["Reserved share", "Protected tenant keeps a capacity floor", "Reserved cores cannot be borrowed when idle", "Reservation too small for the protected demand"],
      ["Separate pools", "No shared CPU contention", "Duplicated baseline and lower utilization", "Cost; cross-tenant dependencies remain elsewhere"],
      ["Scheduling window", "Batch runs when interactive demand is low", "Delay and a calendar that can be wrong", "Overlap during an unexpected interactive peak"],
    ],
  },
  {
    type: "p",
    text: "This model uses abstract cores, a fixed 14-core interactive requirement, and an illustrative queueing curve. It is a teaching model, not an instance benchmark. The 32-core pool, the 48-core batch job, and the latency thresholds are chosen to make the conflict visible in under a minute.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Interactive tail latency (p99, the 99th percentile) and error rate against the shared pool's allocation.",
      "Cores served to batch and cores throttled by the quota or reservation.",
      "Pool utilization, which can look healthy while one tenant starves another.",
      "A flow view from each tenant into the shared pool, with the batch tenant marked when it is throttled.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then run The noisy neighbor. Watch the batch tenant's ramp and the interactive p99 together. Try Quota only and Recovery: both restore latency, but one throttles batch and the other adds capacity. Then run the guided experiment before moving the sliders.",
  },
  { type: "sim", simId: "noisy-neighbor" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The batch tenant ramped from 4 to 48 cores in a 32-core pool. With no quota and no reservation, it took every core it could. Interactive work still needed 14 cores, but only a fraction of a core remained, so its queueing delay exploded and requests were rejected. Pool utilization looked efficient; the interactive tenant was failing.",
  },
  {
    type: "p",
    text: "A 60% quota capped batch at 19.2 cores and left 12.8 for interactive, which was still below the 14-core requirement until the pool was enlarged. The recovery preset used a 64-core pool, a 60% quota, and a 35% reservation to restore headroom. Moving batch to its own pool worked too, at the cost of a second baseline.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-tenant CPU and throttling: Amazon Elastic Container Service (ECS) task CPU utilization and cgroup throttling, Amazon Elastic Kubernetes Service (EKS) container CPU throttling, or AWS Batch job utilization. A total pool average hides the tenant that is winning.",
      "Latency split by tenant or route: ALB target response time per target group, or an application metric keyed by tenant. The victim's p99 rises before the pool average moves.",
      "Queueing signals: run-queue length, scheduler wait time, and request concurrency per tenant. Saturation is a queue, not a percentage.",
      "Batch job duration and start time: a job that suddenly runs longer is either throttled by a new quota or competing for the same cores.",
      "Dependency amplification: database connections and retries from the interactive tier rise after the batch burst starts.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split pool utilization by tenant. Put the batch job's start time and the interactive p99 rise on one timeline. Check whether a quota or reservation exists and what value it has. Then check whether the batch tenant is throttled or simply consuming everything it is allowed to consume.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the coupling: the batch burst started before the interactive latency rise, and both share the same resource.",
      "Protect the victim immediately with a reservation or a quota that leaves at least the interactive requirement free.",
      "Move batch to its own pool if the contention is structural and the cost is justified; scheduling is a weaker fix because the calendar can be wrong.",
      "Size the quota from the protected tenant's peak, not from the average. A quota that still leaves the pool oversubscribed at peak is not a floor.",
      "Add a per-tenant latency service-level objective (SLO) and alert on it. A pool-level CPU alert fires after the victim is already slow.",
      "Test with the batch job starting during an interactive peak, not only during the quiet window it was scheduled for.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A quota keeps the pool shared and efficient but slows the batch tenant and can leave cores idle when the quota is conservative.",
      "A reservation protects latency and strands capacity whenever the protected tenant is quiet.",
      "Separate pools remove the shared failure mode and duplicate the baseline cost; they are the right answer when the latency difference is a product requirement.",
      "Scheduling is cheap and fragile. It works until the batch job overruns or the interactive peak moves.",
      "More capacity reduces contention without deciding who gets the last core; it is a cost decision, not an isolation policy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-tenant",
    question:
      "Interactive p99 doubles at 09:00 every weekday. The pool's average CPU is 70%. How do you find the noisy neighbor?",
    difficulty: 3,
    hints: [
      "Split the resource metric by tenant or workload class.",
      "Compare the latency rise with the batch schedule.",
    ],
    answer:
      "I would split CPU consumption and latency by tenant rather than trust the pool average. A batch job that starts at 09:00 and consumes the margin can leave the average near 70% while the interactive tenant's remaining capacity is saturated. I would put batch start time, per-tenant CPU, per-tenant p99, and throttling on one timeline, then check whether the interactive errors are queueing rejections rather than dependency failures. If the batch job is the cause, the fix is a quota, a reservation, or a separate pool, not a larger average utilization target.",
    followUps: [
      "What if the batch job is already under a quota?",
      "Which metric would you alert on?",
      "How would you prove the cause after the fact?",
    ],
    redFlags: [
      "Starts with database tuning.",
      "Uses only pool average CPU.",
      "Suggests retries or a bigger timeout.",
    ],
    rubric: [
      "Splits by tenant.",
      "Correlates schedule with latency.",
      "Names quota, reservation, or isolation.",
      "Distinguishes queueing from dependency failure.",
    ],
  },
  {
    id: "quota-vs-reservation",
    question:
      "What is the difference between a per-tenant quota and a reserved capacity share, and when would you use each?",
    difficulty: 3,
    hints: [
      "A quota limits the aggressor; a reservation protects the victim.",
      "Both reduce the pool's usable capacity in different states.",
    ],
    answer:
      "A quota caps how much one tenant may consume. It contains the aggressor but does not guarantee that the victim gets a specific share, because other tenants can still consume the rest. A reservation sets aside capacity that the aggressor cannot take, so the victim keeps a floor even when the pool is otherwise busy. I would use a quota when the main risk is a single tenant monopolizing the pool, and a reservation when a latency-sensitive tenant needs a guaranteed floor. A reservation costs more when the protected tenant is idle; a quota costs batch throughput.",
    followUps: [
      "How do you set the numbers?",
      "What happens when the protected tenant exceeds its reservation?",
      "Can you combine both?",
    ],
    redFlags: [
      "Treats the terms as synonyms.",
      "Says a quota guarantees the victim's share.",
      "Ignores idle reserved capacity.",
    ],
    rubric: [
      "Defines both mechanisms.",
      "Explains victim versus aggressor.",
      "States the utilization cost.",
      "Combines them sensibly.",
    ],
  },
  {
    id: "isolation-cost",
    question:
      "The team wants to give every tenant its own pool. What would you ask before agreeing?",
    difficulty: 3,
    hints: [
      "Isolation removes sharing but not all dependencies.",
      "Compare the cost of idle baselines with the value of the latency guarantee.",
    ],
    answer:
      "I would ask what latency guarantee each tenant actually needs and what the duplicated baseline costs. Separate pools remove CPU contention but duplicate minimum capacity, patching, and observability, and they can leave each pool underutilized. If only one tenant is latency-sensitive, a reservation or a quota may buy the same guarantee at a lower cost. I would also check for shared dependencies that remain, such as a database or a downstream service, because isolating compute does not isolate those.",
    followUps: [
      "Which tenants would you isolate first?",
      "How would you measure the benefit?",
      "What shared dependencies remain?",
    ],
    redFlags: [
      "Says isolation is always better.",
      "Ignores cost.",
      "Assumes separate pools remove every shared failure.",
    ],
    rubric: [
      "Ties isolation to a requirement.",
      "Quantifies duplicate cost.",
      "Mentions remaining shared dependencies.",
      "Considers a cheaper partial isolation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every shared pool has a documented per-tenant quota and reservation, derived from the protected tenant's peak.",
      "Dashboards split CPU, throttling, and latency by tenant, not only by pool.",
      "Batch jobs have a named owner, a schedule, and a concurrency limit.",
      "A per-tenant latency SLO exists for the workloads that share a pool.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm which tenant started or grew before the latency rise.",
      "Protect the victim with a reservation or quota before adding capacity.",
      "Check whether the batch tenant is throttled or simply consuming its full quota.",
      "Check shared dependencies for amplification before blaming the database.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-size the quota and reservation from observed peaks, not from the average.",
      "Decide whether the batch workload belongs in a separate pool.",
      "Add a test that starts batch during an interactive peak.",
      "Record the utilization cost of the chosen isolation level.",
    ],
  },
];

const references = [
  {
    title: "AWS Well-Architected SaaS Lens: Noisy Neighbor",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/noisy-neighbor.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines the multi-tenant noisy-neighbor problem and the isolation strategies that bound it.",
  },
  {
    title: "Google SRE Book: Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google",
    kind: "book" as const,
    note: "Per-customer quotas, criticality, and client-side throttling for shared capacity.",
  },
  {
    title: "AWS Batch: fair-share scheduling",
    url: "https://docs.aws.amazon.com/batch/latest/userguide/fair-share-scheduling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Scheduling policy that shares a compute environment between workloads instead of isolating pools.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "noisy-neighbor": {
      model: noisyNeighborModel,
      presets,
      instructions:
        "Start healthy, then run The noisy neighbor. Compare Quota only and Recovery. Watch interactive p99, pool utilization, and the cores throttled from batch.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Cores, latency, and utilization thresholds are teaching values. A core is an abstract unit, not an instance type.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-bulkheads",
    "capacity-queueing-headroom",
    "capacity-rightsizing",
    "capacity-observability-cost",
    "case-shared-platform-quota",
  ],
};
