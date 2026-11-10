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

const DEMAND_RPS = 12_000;
const WRITE_RPS = 1_800;
const RPO_TARGET = 60;
const CUTOVER_S = 20;

const params: ParamSpec[] = [
  {
    id: "primaryErrorPct",
    label: "Primary region error rate",
    min: 0,
    max: 100,
    step: 1,
    value: 0,
    unit: "%",
    group: "Primary",
    help: "Share of requests failing in the active region. A degraded region can be failing a few percent without being down.",
    format: "percent",
  },
  {
    id: "failoverActive",
    label: "Regional failover",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Decision",
    help: "1 shifts traffic to the standby region. 0 keeps traffic in the current region.",
    format: "count",
  },
  {
    id: "replicaLagS",
    label: "Replication lag",
    min: 0,
    max: 600,
    step: 5,
    value: 2,
    unit: " s",
    group: "Data",
    help: "How far the standby is behind at promotion. Lost writes are approximately write rate times this lag.",
    format: "number",
  },
  {
    id: "standbyCapacityPct",
    label: "Standby capacity",
    min: 30,
    max: 200,
    step: 5,
    value: 150,
    unit: "%",
    group: "Capacity",
    help: "Standby serving capacity as a share of normal peak demand. Below 100% cannot absorb the full load.",
    format: "percent",
  },
  {
    id: "demandPct",
    label: "Current demand",
    min: 50,
    max: 150,
    step: 5,
    value: 100,
    unit: "%",
    group: "Capacity",
    help: "Traffic at the moment of the decision, relative to normal peak demand.",
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
  elapsed: number;
  primaryError: number;
  lag: number;
  standbyCapacity: number;
  demand: number;
  inCutover: boolean;
  standbyUtil: number;
  errors: number;
  lostWrites: number;
  rpoOverrun: number;
  demandRps: number;
  standbyRps: number;
}

function compute(p: Params, elapsed: number): Computed {
  const active = num(p, "failoverActive", 0) >= 0.5;
  const primaryError = clamp(num(p, "primaryErrorPct", 0), 0, 100);
  const lag = clamp(Math.round(num(p, "replicaLagS", 2)), 0, 600);
  const standbyCapacity = clamp(Math.round(num(p, "standbyCapacityPct", 150)), 30, 200);
  const demand = clamp(Math.round(num(p, "demandPct", 100)), 50, 150);
  const inCutover = active && elapsed < CUTOVER_S;
  const standbyUtil = active ? (demand / standbyCapacity) * 100 : 0;
  const capacityErrors = active ? Math.max(0, ((demand - standbyCapacity) / demand) * 100) : 0;
  const errors = !active ? primaryError : inCutover ? 100 : clamp(capacityErrors, 0, 100);
  const demandRps = (DEMAND_RPS * demand) / 100;
  const standbyRps =
    active && !inCutover ? Math.min(demandRps, (DEMAND_RPS * standbyCapacity) / 100) : 0;
  return {
    active,
    elapsed,
    primaryError,
    lag,
    standbyCapacity,
    demand,
    inCutover,
    standbyUtil,
    errors,
    lostWrites: active ? WRITE_RPS * lag : 0,
    rpoOverrun: active ? Math.max(0, lag - RPO_TARGET) : 0,
    demandRps,
    standbyRps,
  };
}

function health(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.6))),
    );
  }
}

function buildFrame(p: Params, elapsed: number, seed: number): SimFrame {
  const c = compute(p, elapsed);
  const lbHealth = health(c.errors, 1, 5);
  const primaryHealth: Health = health(c.primaryError, 1, 5);
  const standbyHealth: Health = !c.active
    ? "ok"
    : c.inCutover
      ? "warn"
      : health(c.standbyUtil, 80, 100);
  const dataHealth: Health = c.active ? health(c.rpoOverrun, 10, 60) : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "users",
        label: "Global traffic",
        kind: "client",
        health: "ok",
        throughput: c.demandRps,
        sublabel: `${formatCount(c.demandRps)} req/s`,
        detail:
          "Traffic arrives through one global entry point. The entry point can move it, but the destination must be able to serve it.",
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Global load balancer",
        kind: "lb",
        health: lbHealth,
        utilization: clamp(c.errors / 100),
        throughput: c.demandRps,
        sublabel: `${c.errors.toFixed(0)}% requests failing`,
        detail: c.active
          ? `Traffic is shifting to the standby. Cutover has ${c.inCutover ? `${Math.max(0, CUTOVER_S - c.elapsed).toFixed(0)}s` : "completed"}.`
          : "Traffic remains in the primary region.",
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Primary · us-east-1",
        kind: "service",
        health: primaryHealth,
        utilization: clamp(c.primaryError / 100),
        throughput: c.active ? 0 : c.demandRps * (1 - c.primaryError / 100),
        sublabel: c.active ? "abandoned" : `${c.primaryError.toFixed(0)}% errors`,
        detail:
          "A degraded region is not the same as a failed region. Staying keeps data local but exposes customers to the current error rate.",
        meta: { view: "flow" },
      },
      {
        id: "primary-db",
        label: "Primary database",
        kind: "db",
        role: "primary",
        health: c.primaryError > 5 ? "warn" : "ok",
        utilization: c.active ? 1 : clamp(c.demand / 200),
        throughput: c.active ? 0 : (WRITE_RPS * c.demand) / 100,
        sublabel: c.active
          ? "no longer authoritative"
          : `${formatCount((WRITE_RPS * c.demand) / 100)} writes/s`,
        detail:
          "The primary database is the source of truth until promotion. After promotion it is a stale copy that must not accept writes.",
        meta: { view: "flow" },
      },
      {
        id: "standby",
        label: "Standby · us-west-2",
        kind: "service",
        health: standbyHealth,
        utilization: clamp(c.standbyUtil / 100),
        throughput: c.standbyRps,
        sublabel: c.active ? `${Math.round(c.standbyUtil)}% utilized` : "warm standby",
        detail:
          "The standby can absorb traffic only if its capacity matches current demand. A warm process is not the same as enough headroom.",
        meta: { view: "flow" },
      },
      {
        id: "standby-db",
        label: "Standby database",
        kind: "db",
        role: "replica",
        health: dataHealth,
        utilization: clamp(c.rpoOverrun / Math.max(1, RPO_TARGET)),
        throughput: c.active ? (WRITE_RPS * c.demand) / 100 : 0,
        sublabel: `${c.lag}s behind · RPO ${RPO_TARGET}s`,
        detail: `Promotion discards commits after the standby's last received point. The loss is about write rate times lag: ${formatCount(c.lostWrites)} writes.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("users-lb", "users", "lb", 1, lbHealth),
      edge("lb-primary", "lb", "primary", c.active ? 0 : 1, primaryHealth),
      edge("lb-standby", "lb", "standby", c.active ? 1 : 0, standbyHealth),
      edge("primary-db", "primary", "primary-db", c.active ? 0 : 0.8, primaryHealth),
      edge("standby-db", "standby", "standby-db", c.active ? 0.8 : 0.1, dataHealth),
      edge("replication", "primary-db", "standby-db", c.active ? 0 : 0.7, dataHealth),
    ],
    metrics: [
      metric("failover-errors", "Request error rate", c.errors, "%", 1, 5, "percent"),
      metric("standby-utilization", "Standby utilization", c.standbyUtil, "%", 80, 100, "percent"),
      metric("rpo-overrun", "RPO overrun", c.rpoOverrun, " s", 10, 60, "number"),
      metric(
        "lost-writes",
        "Writes at risk",
        c.lostWrites,
        " writes",
        undefined,
        undefined,
        "count",
      ),
      metric(
        "standby-throughput",
        "Standby served traffic",
        c.standbyRps,
        " req/s",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: { seed, multiRegionElapsed: c.elapsed, failoverActive: c.active ? 1 : 0 },
    summary: `${c.errors.toFixed(0)}% requests failing; standby at ${Math.round(c.standbyUtil)}%; ${formatCount(c.lostWrites)} writes at risk; RPO overrun ${c.rpoOverrun}s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failover-errors",
    metricId: "failover-errors",
    warn: 1,
    crit: 5,
    title: "The failover is causing more errors than the degraded region",
    cause:
      "Cutover stopped traffic before the standby could serve it, or the standby cannot absorb current demand. A failover that increases errors has made the incident worse.",
    fix: "Verify standby capacity and health before moving traffic, then shift traffic in stages with a rollback threshold. If the standby is undersized, stay in the degraded region and reduce load there instead.",
    checkFirst: [
      "Compare the error rate before and after the decision.",
      "Check whether cutover is still in progress or capacity is the limit.",
      "Check whether traffic is reaching the standby at all.",
    ],
  },
  {
    id: "standby-utilization",
    metricId: "standby-utilization",
    warn: 80,
    crit: 100,
    title: "The standby region cannot absorb the full load",
    cause:
      "Standby capacity is sized for a fraction of peak demand. Failing over moves all traffic to a region that was never built to serve it.",
    fix: "Pre-scale the standby to the tested failover load, shed low-value traffic during cutover, and set a traffic ramp with a capacity gate. Do not promote a region just because it is running.",
    checkFirst: [
      "Compare standby capacity with current demand.",
      "Check whether autoscaling in the standby can warm before traffic arrives.",
      "Check which traffic classes can be shed during the ramp.",
    ],
  },
  {
    id: "rpo-overrun",
    metricId: "rpo-overrun",
    warn: 10,
    crit: 60,
    title: "Promotion will exceed the stated recovery point objective",
    cause:
      "Replication lag at promotion is larger than the RPO allows. The standby is consistent at an earlier point, so every commit after that point is lost.",
    fix: "Do not promote an asynchronous standby beyond the RPO without an explicit business decision. Drain the primary if it is reachable, wait for replication if the degradation allows it, or reconcile the lost window from logs and idempotency records.",
    checkFirst: [
      "Measure lag at the moment of promotion, not the daily average.",
      "Compare the lost-write estimate with the RPO and the business impact.",
      "Check whether the old primary can still be read for reconciliation.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-regional-failover",
  title: "Predict the cost of an unprepared regional failover",
  simId: "multi-region",
  question:
    "The primary region is failing 3% of requests. The standby is 120 seconds behind and has capacity for 40% of normal demand. Should you fail over now?",
  prediction: {
    options: [
      { id: "immediate", label: "Fail over immediately; any regional degradation justifies it" },
      {
        id: "contain",
        label: "Stay, contain the 3% degradation, and prepare the standby before moving traffic",
      },
      { id: "both", label: "Fail over and send writes to both regions at once" },
      { id: "wait", label: "Wait for the primary to fail completely, then decide" },
    ],
    correctOptionId: "contain",
    explanation:
      "A 3% error rate is painful but bounded. Failing over to a standby with 40% of demand capacity creates a much larger outage, and 120 seconds of lag exceeds the 60-second RPO. The decision must compare the current degradation with the failover's error, capacity, and data-loss cost.",
  },
  setup: defaults({
    primaryErrorPct: 3,
    failoverActive: 1,
    replicaLagS: 120,
    standbyCapacityPct: 40,
    demandPct: 100,
  }),
  runFor: 30,
  observe: [
    "Request errors rise to about 60% after cutover because the standby can serve only 40% of demand.",
    "The standby runs at 250% utilization and crosses both capacity thresholds.",
    "The RPO overrun is 60 seconds and the lost-write estimate is about 216,000.",
    "The current degradation was 3%; the failover is far worse.",
  ],
  explain:
    "A regional failover is an availability trade, not a free reset. The standby must have capacity for current demand, and the replication lag must fit the RPO. When the primary is degraded but still serving, containment is often cheaper than an unprepared cutover.",
  fix: defaults({
    primaryErrorPct: 3,
    failoverActive: 0,
    replicaLagS: 120,
    standbyCapacityPct: 40,
    demandPct: 100,
  }),
  debrief:
    "Staying keeps the error rate at 3% and loses no writes. The standby remains a recovery option once it is scaled and its lag is inside the RPO. The correct decision depends on how the degradation is trending, not on the word failover.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A multi-region failover moves traffic and writes from a degraded region to a standby. It is an availability decision with two hidden costs: the standby must be able to serve current demand, and asynchronous replication means some committed writes may not exist in the standby. A region that is slow or failing a few percent of requests is not automatically a region to abandon.",
  },
  {
    type: "p",
    text: "The decision has three inputs. The current customer impact tells you what staying costs. The standby capacity tells you what failing over can serve. The replication lag tells you what data the promotion will discard. The recovery time objective (RTO) is how long the move takes; the recovery point objective (RPO) is how much committed data it may lose. A runbook is the fourth input: a tested sequence for detection, decision, promotion, traffic shift, and rollback.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The decision sits above both regions, at the global traffic layer and the data replication layer. The traffic layer can shift requests, but it cannot create capacity. The data layer can promote a standby, but it cannot replay commits the standby never received. The application layer must know which region is writable and how to behave during cutover.",
  },
  {
    type: "table",
    headers: ["Input", "Question", "Failure if ignored"],
    rows: [
      ["Customer impact", "How bad is staying?", "Failing over from a tolerable degradation"],
      ["Standby capacity", "Can it serve current demand?", "A second, larger outage"],
      ["Replication lag", "How much data will be lost?", "RPO breach discovered after promotion"],
      ["Runbook", "Has the sequence been tested?", "Slow, improvised cutover"],
      ["Reversibility", "Can we fail back?", "A permanent split or stale writer"],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative: 12,000 requests per second, 1,800 writes per second, and a 60-second RPO. The model compresses the decision into simulated seconds. Real cutover times, standby warmup, and data loss depend on the architecture and must be measured, not assumed.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request error rate before and after the decision.",
      "Standby utilization against its real capacity.",
      "RPO overrun and the estimated writes at risk.",
      "Cutover progress and whether traffic is reaching the standby.",
      "Primary and standby health as separate states, not one global status.",
    ],
  },
  {
    type: "compare",
    leftTitle: "Stay in a degraded region",
    rightTitle: "Fail over to a standby",
    rows: [
      {
        label: "Availability",
        left: "Reduced by the current fault",
        right: "Depends on standby capacity",
      },
      {
        label: "Data loss",
        left: "None from promotion",
        right: "Write rate times replication lag",
      },
      {
        label: "Time to change",
        left: "Immediate",
        right: "Detection, decision, promotion, cutover",
      },
      { label: "Reversibility", left: "Already there", right: "Failback is another risky cutover" },
      {
        label: "Best when",
        left: "Impact is bounded and trending down",
        right: "Region is failing and standby is proven",
      },
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Degraded primary without failing over. Watch the bounded error rate. Apply Blind failover and compare the cutover errors, standby utilization, and RPO overrun. Then apply Tested failover to see the same decision with enough capacity and an acceptable lag. Run the experiment before revealing the answer.",
  },
  { type: "sim", simId: "multi-region" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the experiment, the primary was failing 3% of requests. Failing over stopped traffic for the cutover, then sent full demand to a standby sized for 40% of it. Request errors rose to about 60%, the standby reached 250% utilization, and promotion discarded 120 seconds of writes. The failover converted a bounded degradation into a larger outage and a data-loss event.",
  },
  {
    type: "p",
    text: "Staying kept errors at 3% and lost no writes. The standby stayed available as a recovery option. The right decision was not to avoid failover forever; it was to prepare the standby and the runbook first, then move when the current impact or the failure trajectory justified the cost.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Global error rate split by region, with the primary region's degradation visible before the decision.",
      "Standby CPU, connection, and queue utilization against the tested failover load.",
      "Replication lag in seconds and the write rate used to estimate lost commits.",
      "Cutover duration and the traffic percentage actually reaching the standby.",
      "A stale old writer still accepting writes after promotion, which is a split-brain risk.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the current error rate with what the standby can serve. Check replication lag against the RPO, confirm the standby is healthy and writable, and confirm the runbook's cutover sequence. If the primary is still serving and the degradation is bounded, containment may be the safer incident action.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Quantify the current impact and its trend before choosing a region.",
      "Verify standby capacity against current demand, not against last year's peak.",
      "Measure replication lag and estimate the writes at risk.",
      "Decide explicitly whether the RPO breach is acceptable; record the decision.",
      "Promote the standby, stop writes to the old primary, and shift traffic in stages.",
      "Watch error rate, standby utilization, and data reconciliation during the ramp.",
      "Rehearse the same decision and cutover in a game day before the real event.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Staying avoids data loss and cutover risk but accepts the current customer impact.",
      "Failing over can restore service quickly only when the standby has enough capacity and is already warm.",
      "A synchronous standby gives a smaller RPO but adds write latency in normal operation.",
      "A failed-over state is expensive to run and risky to reverse; plan the failback before you need it.",
      "Shedding low-value traffic can make a degraded region survivable without a regional cutover.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "failover-decision",
    question: "One region is failing 4% of requests. How do you decide whether to fail over?",
    difficulty: 4,
    hints: [
      "Compare the cost of staying with the cost of moving.",
      "Capacity, RPO, and reversibility are part of the cost.",
    ],
    answer:
      "I compare the current customer impact and its trend with the standby's tested capacity and the replication lag. If the standby cannot serve current demand, or the lag exceeds the RPO, failing over may create a larger outage and a data-loss event. I also check whether containment, load shedding, or a partial traffic shift can reduce impact without a full cutover. If the primary is failing and the standby is proven, I fail over with a staged traffic ramp and a rollback threshold.",
    followUps: [
      "What would make you decide immediately?",
      "How do you handle a standby that is healthy but cold?",
      "Who accepts the RPO breach?",
    ],
    redFlags: [
      "Fails over because the region is degraded.",
      "Ignores standby capacity.",
      "Treats RPO as a technical detail.",
    ],
    rubric: [
      "Compares both costs.",
      "Checks capacity and RPO.",
      "Considers containment.",
      "Defines a staged cutover.",
    ],
  },
  {
    id: "capacity",
    question: "The standby is running but sized for 40% of peak. What do you do before a failover?",
    difficulty: 3,
    hints: [
      "A running process is not enough capacity.",
      "Pre-scaling and load shedding can close the gap.",
    ],
    answer:
      "I would pre-scale the standby to the tested failover load, verify that its dependencies and quotas can scale too, and define which traffic can be shed during the ramp. If the standby cannot reach the required capacity in time, I would keep traffic in the degraded region, reduce load there, and treat the standby as a partial recovery option rather than a full replacement.",
    followUps: [
      "How do you test standby capacity?",
      "What dependencies are easy to forget?",
      "When is a partial failover better than none?",
    ],
    redFlags: [
      "Assumes autoscaling will handle it instantly.",
      "Forgets database and quota limits.",
      "Sends full traffic to a cold region.",
    ],
    rubric: [
      "Pre-scales and tests.",
      "Checks dependencies.",
      "Defines shedding.",
      "Considers partial failover.",
    ],
  },
  {
    id: "rpo",
    question: "Replication lag is 120 seconds and the RPO is 60. How do you proceed?",
    difficulty: 4,
    hints: [
      "Promotion loses writes after the standby's last received point.",
      "The decision to breach RPO belongs to the business.",
    ],
    answer:
      "I would quantify the loss as write rate times lag and explain that promotion discards every commit after the standby's last received point. I would check whether the primary is reachable to drain or reconcile, and whether waiting for lag to fall is compatible with the current impact. If not, I would escalate the RPO breach to the business owner, record the decision, and plan reconciliation from logs and idempotency records. I would not promote silently and discover the loss afterward.",
    followUps: [
      "How do you reconcile after promotion?",
      "What if the old primary is unreachable?",
      "How do you prevent this in the next incident?",
    ],
    redFlags: [
      "Promotes without quantifying loss.",
      "Assumes replication is synchronous.",
      "Hides the RPO breach from the business.",
    ],
    rubric: [
      "Quantifies loss.",
      "Escalates the breach.",
      "Plans reconciliation.",
      "Records the decision.",
    ],
  },
  {
    id: "failback",
    question: "The failover worked. When and how do you fail back?",
    difficulty: 3,
    hints: [
      "Failback is another cutover with its own risk.",
      "Data reconciliation comes before traffic.",
    ],
    answer:
      "I would keep the standby as the writer until the old region is healthy, reconciled, and replication is restored in the reverse direction. Then I would schedule a planned switchover with a tested runbook, shift traffic in stages, and keep the ability to abort. I would not fail back during the same incident unless the standby cannot continue, because every cutover carries the same capacity and data-loss risks.",
    followUps: [
      "How do you reverse replication?",
      "What data must be reconciled first?",
      "How long can you run in the standby?",
    ],
    redFlags: [
      "Fails back immediately after recovery.",
      "Skips reconciliation.",
      "Treats failback as routine.",
    ],
    rubric: [
      "Waits for health and reconciliation.",
      "Reverses replication safely.",
      "Uses a planned switchover.",
      "Keeps an abort path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Standby capacity is tested against current peak demand, including dependencies.",
      "Replication lag and RPO are measured continuously and visible to the decision maker.",
      "The failover runbook covers decision, promotion, traffic shift, and rollback.",
      "A game day has exercised the same cutover with production-like traffic.",
      "Low-value traffic classes are ranked for shedding during a ramp.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Quantify current impact and its trend before choosing to move.",
      "Check standby capacity and replication lag at the moment of promotion.",
      "Escalate and record any RPO breach before promoting.",
      "Shift traffic in stages and watch error rate and standby utilization.",
      "Stop writes to the old primary to avoid a split brain.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile writes lost between the standby's last point and promotion.",
      "Verify that the old primary cannot accept writes.",
      "Compare actual cutover time and capacity with the runbook assumptions.",
      "Update the standby size, RPO, and decision thresholds.",
      "Schedule a planned failback only after the old region is healthy and replicated.",
    ],
  },
];

const references = [
  {
    title: "Disaster Recovery Workloads on AWS",
    url: "https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Recovery strategies, RTO and RPO, and the capacity assumptions behind each one.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Decision-making and coordination during a large incident.",
  },
  {
    title: "Failover process for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "What promotion changes and why the application must handle the new writer.",
  },
];

export const multiRegionModel: SimModel = {
  id: "reliability-multi-region",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const active = num(p, "failoverActive", 0) >= 0.5;
    const wasActive = frame.flags.failoverActive === 1;
    const previous = Math.max(0, Number(frame.flags.multiRegionElapsed ?? 0));
    const elapsed = !active ? 0 : wasActive ? previous + Math.max(0, dt) : Math.max(0, dt);
    const c = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, elapsed, seed);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      multiRegionElapsed: elapsed,
      failoverActive: active ? 1 : 0,
    };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);

    if (active && !wasActive) {
      pushEvent(next, {
        id: "multi-region-failover-start",
        at: frame.t,
        severity: c.lag > RPO_TARGET ? "crit" : "warn",
        title:
          c.lag > RPO_TARGET
            ? "Regional failover started with an RPO breach"
            : "Regional failover started",
        detail: `Standby capacity is ${c.standbyCapacity}% of peak demand and replication lag is ${c.lag}s against a ${RPO_TARGET}s RPO. Promotion risks about ${formatCount(c.lostWrites)} writes.`,
        nodeId: "standby-db",
        metricId: "rpo-overrun",
      });
    }
    if (active && !c.inCutover && c.errors > 5 && frame.flags.multiRegionCapacityEvent !== 1) {
      pushEvent(next, {
        id: "multi-region-capacity",
        at: frame.t,
        severity: "crit",
        title: "Standby cannot absorb the traffic",
        detail: `Demand is ${c.demand}% of peak and standby capacity is ${c.standbyCapacity}%. ${c.errors.toFixed(0)}% of requests are failing after cutover.`,
        nodeId: "standby",
        metricId: "standby-utilization",
      });
      next.flags.multiRegionCapacityEvent = 1;
    }
    if (!active) next.flags.multiRegionCapacityEvent = 0;
    if (c.errors <= 5) next.flags.multiRegionCapacityEvent = 0;
    if (active && !c.inCutover && c.errors === 0 && frame.flags.multiRegionRecovered !== 1) {
      pushEvent(next, {
        id: "multi-region-recovered",
        at: frame.t,
        severity: "info",
        title: "Standby is serving the full load",
        detail: `Requests are succeeding at a ${Math.round(c.standbyUtil)}% standby utilization. Writes lost at promotion still need reconciliation.`,
        nodeId: "standby",
        metricId: "failover-errors",
      });
      next.flags.multiRegionRecovered = 1;
    }
    if (!active || c.errors > 0) next.flags.multiRegionRecovered = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, Math.max(0, Number(frame.flags.multiRegionElapsed ?? 0)));
    const items: string[] = [];
    items.push(
      c.active
        ? `The failover is ${c.inCutover ? "in cutover" : "complete"}. Current demand is ${c.demand}% of peak and standby capacity is ${c.standbyCapacity}%.`
        : `Traffic remains in the primary region, which is failing ${c.primaryError.toFixed(0)}% of requests.`,
    );
    items.push(
      c.active
        ? `Error rate is ${c.errors.toFixed(0)}% and standby utilization is ${Math.round(c.standbyUtil)}%.`
        : `A failover would move demand to a standby with ${c.standbyCapacity}% capacity and ${c.lag}s of replication lag.`,
    );
    items.push(
      `Promotion would risk about ${formatCount(c.lostWrites)} writes and an RPO overrun of ${c.rpoOverrun.toFixed(0)}s.`,
    );
    items.push(
      "A regional failover is justified by the cost of staying, not by the existence of a degraded region.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Capacity short", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "Both regions are healthy, the standby is two seconds behind, and no failover is active.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Degraded primary",
    description:
      "The primary region fails 3% of requests but still serves. Staying is painful, but the standby stays untouched.",
    tone: "warn",
    params: defaults({ primaryErrorPct: 3 }),
  },
  {
    id: "failure",
    label: "Blind failover",
    description:
      "Traffic moves to a standby with 30% capacity and 240 seconds of lag against a 60-second RPO.",
    tone: "crit",
    params: defaults({
      primaryErrorPct: 3,
      failoverActive: 1,
      replicaLagS: 240,
      standbyCapacityPct: 30,
      demandPct: 110,
    }),
    elapsed: 30,
  },
  {
    id: "capacity-tight",
    label: "Capacity tight",
    description:
      "The standby is only 10% above current demand. It serves, but with almost no headroom for a burst.",
    tone: "warn",
    params: defaults({
      failoverActive: 1,
      replicaLagS: 10,
      standbyCapacityPct: 110,
      demandPct: 100,
    }),
    elapsed: 30,
  },
  {
    id: "recovery",
    label: "Tested failover",
    description:
      "A scale-tested standby with 180% capacity and five seconds of lag absorbs the full load inside the RPO.",
    tone: "ok",
    params: defaults({
      failoverActive: 1,
      replicaLagS: 5,
      standbyCapacityPct: 180,
      demandPct: 100,
    }),
    elapsed: 30,
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "multi-region": {
      model: multiRegionModel,
      presets,
      instructions:
        "Start Healthy, apply Degraded primary, and note the bounded error rate. Then apply Blind failover and compare request errors, standby utilization, and RPO overrun. Apply Tested failover to see the same decision with proven capacity and lag. Run the experiment before revealing the answer.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "replication"],
      note: "Illustrative model. Demand, write rate, capacity, cutover time, and RPO are teaching values, not a specific provider's limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-cross-region-rpo",
    "reliability-db-failover",
    "reliability-dependency-failure",
    "reliability-status-pages",
  ],
};
