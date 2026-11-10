import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MONTHLY_MINUTES = 43_200;

const params = [
  {
    id: "topology",
    label: "Topology",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "0 single-AZ, 1 Multi-AZ inside one Region, 2 Multi-AZ plus an asynchronous secondary in another Region.",
    format: "count" as const,
  },
  {
    id: "failureDomain",
    label: "Failure domain",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "0 no failure, 1 one Availability Zone fails, 2 the whole primary Region fails.",
    format: "count" as const,
  },
  {
    id: "secondaryLag",
    label: "Cross-Region lag",
    min: 0,
    max: 300,
    step: 1,
    value: 2,
    unit: "s",
    group: "Replication",
    help: "How far the cross-Region secondary is behind. This becomes the data-loss window on an unplanned regional promotion.",
    format: "number" as const,
  },
  {
    id: "cutoverMinutes",
    label: "Detection and cutover",
    min: 1,
    max: 60,
    step: 1,
    value: 12,
    unit: " min",
    group: "Recovery",
    help: "Minutes from failure detection to writes served in the recovery Region. Illustrative RTO input.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  topology: number;
  domain: number;
  multiAz: boolean;
  multiRegion: boolean;
  lag: number;
  cutover: number;
  rto: number;
  rpo: number;
  downtime: number;
  availability: number;
  cost: number;
  survived: boolean;
  health: Health;
}

function compute(p: Params): Computed {
  const topology = clamp(Math.round(num(p, "topology", 1)), 0, 2);
  const domain = clamp(Math.round(num(p, "failureDomain", 0)), 0, 2);
  const multiAz = topology >= 1;
  const multiRegion = topology >= 2;
  const lag = clamp(num(p, "secondaryLag", 2), 0, 300);
  const cutover = Math.max(0, num(p, "cutoverMinutes", 12));
  const cost = topology === 0 ? 1 : topology === 1 ? 2 : 3.4;
  let rto = 0;
  let rpo = 0;
  let downtime = 0;
  if (domain === 1) {
    if (topology === 0) {
      rto = 720;
      downtime = 720;
      rpo = 0;
    } else {
      rto = 2.5;
      downtime = 2.5;
      rpo = 0;
    }
  } else if (domain === 2) {
    if (multiRegion) {
      rto = cutover;
      downtime = cutover;
      rpo = lag;
    } else {
      rto = 1_440;
      downtime = 1_440;
      rpo = 1_440;
    }
  }
  const availability = 100 * (1 - downtime / MONTHLY_MINUTES);
  const health: Health = rto >= 30 || rpo >= 300 ? "crit" : rto >= 15 || rpo >= 60 ? "warn" : "ok";
  return {
    topology,
    domain,
    multiAz,
    multiRegion,
    lag,
    cutover,
    rto,
    rpo,
    downtime,
    availability,
    cost,
    survived: domain === 0 || (domain === 1 && multiAz) || (domain === 2 && multiRegion),
    health,
  };
}

function topologyName(topology: number): string {
  return topology === 0 ? "Single-AZ" : topology === 1 ? "Multi-AZ" : "Multi-region";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["rto", values.rto, 0.2],
    ["rpo", values.rpo, 0],
    ["availability", values.availability, 0.01],
    ["cost", values.cost, 0.02],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const regionFailed = values.domain === 2;
  const azFailed = values.domain === 1;
  const appHealth: Health = regionFailed
    ? values.multiRegion
      ? "warn"
      : "down"
    : azFailed && values.topology === 0
      ? "down"
      : "ok";
  const writerHealth: Health = regionFailed
    ? "down"
    : azFailed
      ? values.topology === 0
        ? "down"
        : "crit"
      : "ok";
  const standbyHealth: Health = !values.multiAz || regionFailed ? "down" : "ok";
  const secondaryHealth: Health = !values.multiRegion
    ? "down"
    : regionFailed
      ? "warn"
      : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application · us-east-1",
        kind: "service",
        health: appHealth,
        sublabel: regionFailed && values.multiRegion ? "cutting over to us-west-2" : "writer endpoint",
        detail: values.multiRegion
          ? "The application follows the global writer endpoint. A regional promotion moves writes to the secondary Region."
          : "The application is tied to one Region. There is no writable copy elsewhere if the Region fails.",
        meta: { view: "topology" },
      },
      {
        id: "writer",
        label: "Writer · us-east-1a",
        kind: "db",
        role: "primary",
        health: writerHealth,
        utilization: clamp(values.rto / 60),
        sublabel: regionFailed ? "Region unavailable" : azFailed ? "AZ failure" : `${topologyName(values.topology)} writer`,
        detail: values.multiAz
          ? "The primary serves writes. A Multi-AZ standby in another AZ receives synchronous replication inside the same Region."
          : "A single-AZ writer has no standby. An AZ failure takes the database with it.",
        meta: { view: "topology" },
      },
      {
        id: "standby",
        label: "Standby · us-east-1b",
        kind: "db",
        role: "replica",
        health: standbyHealth,
        sublabel: values.multiAz ? "synchronous · RPO 0" : "not provisioned",
        detail: values.multiAz
          ? "The standby is in the same Region. It covers an AZ failure, not a Region failure, and it does not give the application a second Region."
          : "No standby exists. This is the gap a Multi-AZ deployment closes.",
        meta: { view: "topology" },
      },
      {
        id: "secondary",
        label: regionFailed && values.multiRegion ? "Secondary · us-west-2 · promoted" : "Secondary · us-west-2",
        kind: "db",
        role: "replica",
        health: secondaryHealth,
        sublabel: values.multiRegion
          ? regionFailed
            ? "promoted · serving writes"
            : `async · ${values.lag}s behind`
          : "not provisioned",
        detail: values.multiRegion
          ? "Aurora Global Database replicates storage asynchronously. Promotion keeps the secondary's point in time, so the lag becomes data loss."
          : "Without a cross-Region copy, a Region failure has no recovery target inside the RTO.",
        meta: { view: "topology", lag: values.lag },
      },
    ],
    edges: [
      edge("writer-standby", "writer", "standby", values.multiAz ? 1 : 0, values.multiAz ? "ok" : "down", "synchronous"),
      edge("writer-secondary", "writer", "secondary", values.multiRegion ? clamp(1 - values.lag / 300) : 0, values.multiRegion ? "ok" : "down", "asynchronous"),
    ],
    metrics: [
      metric("rto", "Recovery time (RTO)", values.rto, " min", 15, 30, "number"),
      metric("rpo", "Data loss window (RPO)", values.rpo, "s", 60, 300, "number"),
      metric("downtime", "Downtime this month", values.downtime, " min", undefined, undefined, "number"),
      metric("availability", "Modeled availability", values.availability, "%", undefined, undefined, "percent"),
      metric("cost", "Relative run cost", values.cost, "x", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${topologyName(values.topology)} · failure domain ${values.domain}: RTO ${values.rto.toFixed(
      1,
    )} min, RPO ${values.rpo}s, monthly availability ${values.availability.toFixed(3)}%, cost ${values.cost}x.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rto",
    metricId: "rto",
    warn: 15,
    crit: 30,
    title: "Recovery time exceeds the 15-minute target",
    cause:
      "The failed failure domain is larger than the topology can absorb. With no writable copy in another Region, recovery waits for the Region to return or for a manual rebuild.",
    fix:
      "Add a cross-Region secondary and rehearse promotion and cutover, or lower the expected RTO only after measuring a real drill.",
    checkFirst: [
      "Identify which failure domain actually failed: one AZ or the whole Region.",
      "Check whether a writable copy exists outside the failed domain.",
      "Measure detection, promotion, DNS, and application cutover separately.",
    ],
  },
  {
    id: "rpo",
    metricId: "rpo",
    warn: 60,
    crit: 300,
    title: "Data-loss window exceeds the target",
    cause:
      "Cross-Region replication is asynchronous. Promoting the secondary keeps its last received point and discards later commits; with no cross-Region copy, the loss is bounded by the last backup instead.",
    fix:
      "Reduce lag, promote the least-lagged secondary, or accept the loss and reconcile. For a regional outage, a backup alone does not meet an RPO measured in seconds.",
    checkFirst: [
      "Read per-secondary lag before promotion.",
      "Compare the lag with the stated RPO.",
      "Check whether an old-primary snapshot or backup is available for reconciliation.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const topologyModel: SimModel = {
  id: "databases-multi-az-vs-region",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    const failureKey = `${values.topology}-${values.domain}`;
    if (values.domain > 0 && frame.flags.failureKey !== failureKey) {
      pushEvent(next, {
        id: `failure-${failureKey}`,
        at: frame.t,
        severity: values.survived ? "warn" : "crit",
        title: values.survived ? "Failure absorbed by the topology" : "Failure exceeds the topology",
        detail: values.survived
          ? `${topologyName(values.topology)} survived failure domain ${values.domain} with RTO ${values.rto.toFixed(
              1,
            )} min and RPO ${values.rpo}s.`
          : `${topologyName(values.topology)} cannot absorb failure domain ${
              values.domain
            }; recovery depends on the failed Region returning or a manual rebuild.`,
        nodeId: values.survived ? "secondary" : "writer",
        metricId: "rto",
      });
    }
    next.flags.failureKey = failureKey;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.domain === 2 && !values.multiRegion) {
      items.push(
        `A Region failure takes the writer and the Multi-AZ standby together. The ${values.cost}x Multi-AZ cost buys AZ tolerance, not Region tolerance.`,
      );
    }
    if (values.domain === 1 && values.multiAz) {
      items.push(
        "An AZ failure is absorbed inside the Region: the synchronous standby has every committed write, so RPO is 0 and recovery is a failover measured in minutes.",
      );
    }
    if (values.multiRegion) {
      items.push(
        `The cross-Region copy is asynchronous. At ${values.lag}s behind, an unplanned promotion loses about ${values.lag}s of writes; a planned switchover can wait for synchronization.`,
      );
    }
    items.push(
      `At ${values.downtime.toFixed(1)} minutes of downtime, modeled monthly availability is ${values.availability.toFixed(
        3,
      )}%. A 99.99% monthly budget is about 4.32 minutes, so a 15-minute RTO and 99.99% in the same month are different promises.`,
    );
    items.push(
      `Relative run cost is ${values.cost}x single-AZ in this model. Multi-region is not just a second database; it adds cross-Region transfer, duplicate capacity, and a promotion runbook.`,
    );
    if (values.domain === 0) {
      items.push("No failure is active. Change the failure domain to compare what each topology actually survives.");
    }
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
    label: "Healthy multi-region",
    description: "Multi-AZ in us-east-1 with an asynchronous secondary in us-west-2 and two seconds of lag.",
    tone: "ok",
    params: defaults({ topology: 2, failureDomain: 0, secondaryLag: 2, cutoverMinutes: 12 }),
  },
  {
    id: "peak",
    label: "Regional promotion",
    description: "A Region failure is absorbed by the secondary, but 90 seconds of lag and an 18-minute cutover both warn.",
    tone: "warn",
    params: defaults({ topology: 2, failureDomain: 2, secondaryLag: 90, cutoverMinutes: 18 }),
  },
  {
    id: "failure",
    label: "Multi-AZ, Region lost",
    description: "Multi-AZ protects two AZs, but a Region failure has no writable copy and recovery is measured in a day.",
    tone: "crit",
    params: defaults({ topology: 1, failureDomain: 2, secondaryLag: 20, cutoverMinutes: 14 }),
  },
  {
    id: "az-failure",
    label: "AZ failure",
    description: "One AZ fails. Multi-AZ promotes the synchronous standby with RPO 0.",
    tone: "ok",
    params: defaults({ topology: 1, failureDomain: 1, secondaryLag: 20, cutoverMinutes: 12 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The Region failure is absorbed by a secondary that is 20 seconds behind and promoted in 12 minutes.",
    tone: "ok",
    params: defaults({ topology: 2, failureDomain: 2, secondaryLag: 20, cutoverMinutes: 12 }),
  },
];

const experiment: Experiment = {
  id: "is-multi-az-enough",
  title: "Does Multi-AZ meet a 15-minute regional RTO?",
  simId: "multi-az-vs-region",
  question:
    "The business wants 99.99% availability and a 15-minute RTO. The database is RDS Multi-AZ across three AZs in one Region. A whole Region fails. Is the requirement met?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Three AZs and a synchronous standby cover the requirement." },
      { id: "region", label: "No. A Region failure takes the writer and standby; there is no writable copy elsewhere." },
      { id: "rpo", label: "Yes, but only because the standby has RPO 0." },
      { id: "reads", label: "No, because the standby cannot serve reads." },
    ],
    correctOptionId: "region",
    explanation:
      "Multi-AZ places the standby in another AZ inside the same Region. It protects against one AZ failing and gives RPO 0 for that failure, but a Region failure takes both copies. Recovery then waits for the Region to return or for a manual rebuild from backup, which is far outside 15 minutes. Covering a Region failure requires a copy in another Region and a rehearsed promotion path.",
  },
  setup: defaults({ topology: 1, failureDomain: 2, secondaryLag: 20, cutoverMinutes: 14 }),
  runFor: 20,
  observe: [
    "The Multi-AZ standby is healthy, but it is in the same Region as the failed writer.",
    "RTO is about 1,440 minutes, far beyond the 15-minute target.",
    "The writer and application are unavailable; there is no secondary node to promote.",
    "Relative cost is 2x single-AZ, yet the Region failure is not covered.",
  ],
  explain:
    "The topology survives the failure domain it was designed for. Multi-AZ is an AZ-failure design. A Region failure needs a copy outside the Region, which in Aurora means a Global Database secondary or another cross-Region replication mechanism. That copy is asynchronous, so it trades some RPO for regional survivability.",
  fix: defaults({ topology: 2, failureDomain: 2, secondaryLag: 5, cutoverMinutes: 12 }),
  debrief:
    "Adding a cross-Region secondary changes the outcome: promotion takes about 12 minutes and loses about 5 seconds of writes in this model. The cost rises to 3.4x, and the runbook, DNS cutover, and reconciliation still have to be tested. Multi-region buys a different failure domain, not just a second server.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Availability Zone (AZ) is one or more discrete data centers with independent power, cooling, and networking inside a Region. A Region is a geographic area made of multiple AZs. Multi-AZ keeps a synchronous standby in a different AZ in the same Region. Multi-region keeps a copy in a different Region, almost always with asynchronous replication.",
  },
  {
    type: "p",
    text: "The two designs answer different questions. Multi-AZ answers: what happens if one AZ fails? The standby has every committed write, so the recovery point objective (RPO) is 0 and failover is measured in minutes. Multi-region answers: what happens if the whole Region is unavailable? The remote copy is behind, so promotion has a non-zero RPO and a longer recovery time objective (RTO).",
  },
  {
    type: "p",
    text: "Availability math exposes the gap. A 99.99% monthly target allows about 4.32 minutes of downtime in a 30-day month. A 15-minute regional cutover exceeds that for the month in which the event happens. The yearly number may still look acceptable if regional failures are rare, but the promise and the failure budget have to be stated together.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application connects to a writer endpoint. In Multi-AZ, a synchronous standby in another AZ receives every commit before the write is acknowledged. In a Multi-AZ DB cluster, the two standbys can also serve reads; in the classic Multi-AZ instance deployment, the standby is not a read target. Neither standby is in another Region.",
  },
  {
    type: "table",
    headers: ["Topology", "Survives", "RPO for that failure", "Typical recovery"],
    rows: [
      ["Single-AZ", "Instance or process failure", "Depends on backups", "Rebuild or restore"],
      ["Multi-AZ", "One AZ failure", "0 (synchronous)", "Automatic failover, minutes"],
      ["Multi-region", "One Region failure", "Replication lag (asynchronous)", "Promotion plus cutover"],
    ],
  },
  {
    type: "p",
    text: "Aurora Global Database has a primary cluster and up to 10 secondary clusters in other Regions. It replicates storage asynchronously, typically with sub-second latency, and a secondary can be promoted. The global writer endpoint follows the primary. Promotion is not free: the secondary keeps its own point in time, so the lag is the data-loss window.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Topology selector: single-AZ, Multi-AZ, or multi-region.",
      "Failure-domain selector: none, one AZ, or the whole primary Region.",
      "RTO and RPO: the two budgets that decide whether the topology meets the business target.",
      "Monthly downtime and modeled availability: the same failure expressed against a 99.99% budget.",
      "Relative run cost: the multiplier you pay for each additional failure domain.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the AZ failure preset and note RPO 0. Then switch the failure domain to Region while keeping Multi-AZ. Read RTO before changing topology. Switch to multi-region and compare RTO, RPO, and cost, then run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Recovery times, costs, and availability values are illustrative teaching numbers. Real RTO depends on detection, promotion, DNS time to live, application warmup, and capacity; real RPO depends on replication lag at the moment of failure.",
  },
  { type: "sim", simId: "multi-az-vs-region" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Multi-AZ survived the AZ failure with RPO 0 because the standby received every commit synchronously. When the failure domain changed to the whole Region, the same deployment had no writable copy: the writer and standby were both inside the failed Region. RTO jumped to about a day, which is a rebuild-and-restore timeline, not a failover.",
  },
  {
    type: "p",
    text: "Adding the cross-Region secondary changed the failure domain that was covered. Promotion took the configured 12 minutes and lost 5 seconds of writes. Cost rose from 2x to 3.4x. The topology now survives a Region failure, but the RPO is no longer zero, and a 12-minute cutover still exceeds a 99.99% monthly budget in the month of the event.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "RDS events for Multi-AZ failover and Aurora Global Database promotion, with the time each step completed.",
      "CloudWatch AuroraGlobalDBRPOLag for each secondary, compared with the stated RPO.",
      "DNS resolution and time to live, connection-pool reconnect behavior, and application error rates after cutover.",
      "Capacity in the recovery Region: a promoted secondary that cannot absorb the primary's traffic is not a recovery.",
      "Cost and data-transfer lines for cross-Region replication and duplicate standby capacity.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Name the failure domain before comparing topologies. If the event is an AZ failure, check the synchronous standby and RPO 0. If it is a Region failure, check whether a writable copy exists outside the Region and what its lag is. Then compare RTO with the business target, not with the database's internal failover time.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the required availability, RTO, and RPO per data class and per failure domain.",
      "Map each target to a topology: Multi-AZ for AZ tolerance, cross-Region replication for Region tolerance.",
      "Measure detection, promotion, DNS, and application cutover separately in a drill.",
      "Check recovery-Region capacity and pre-scale it, because a promoted writer still has to serve the load.",
      "Reconcile writes lost during an unplanned promotion using the old primary's snapshot, logs, and idempotency records.",
      "Test failback as a planned switchover, and keep both Regions' parameter groups and extensions in sync.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Multi-AZ doubles database capacity cost and covers only an AZ failure; it does not provide a regional recovery target.",
      "Multi-region adds cross-Region transfer, duplicate capacity, and operational complexity, and its asynchronous copy has a non-zero RPO.",
      "Synchronous cross-Region replication would lower RPO but adds commit latency and can hurt availability when the remote Region is slow.",
      "A 15-minute RTO and 99.99% monthly availability are different budgets; satisfying one does not satisfy the other.",
      "A standby that is not exercised is a hypothesis. Drills are part of the cost of claiming the RTO.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "region-gap",
    question: "The database is Multi-AZ and the business asks for regional disaster recovery. What is missing?",
    difficulty: 2,
    hints: [
      "Name the failure domain.",
      "Where does the standby live?",
    ],
    answer:
      "Multi-AZ puts the standby in another AZ inside the same Region. It protects against an AZ failure, not a Region failure, because both copies are in the same Region. Regional DR needs a copy outside the Region, such as an Aurora Global Database secondary or another cross-Region replication path, plus a promotion and cutover runbook. That copy is asynchronous, so it introduces a non-zero RPO and a longer RTO.",
    followUps: [
      "What RPO does that copy have?",
      "How would you test the regional path?",
      "What capacity must exist in the recovery Region?",
    ],
    redFlags: [
      "Says Multi-AZ covers a Region failure.",
      "Confuses AZ and Region.",
      "Ignores the cutover runbook.",
    ],
    rubric: [
      "Names the shared failure domain.",
      "Requires a cross-Region copy.",
      "States the asynchronous RPO.",
      "Mentions promotion and cutover.",
    ],
  },
  {
    id: "rpo-zero",
    question: "Why does Multi-AZ give RPO 0 for an AZ failure while multi-region does not?",
    difficulty: 3,
    hints: [
      "One path waits for the standby before acknowledging.",
      "The other sends asynchronously across distance.",
    ],
    answer:
      "Multi-AZ uses synchronous replication inside the Region: the commit is acknowledged only after the standby has it, so a failover to the standby loses no committed writes. Cross-Region replication is asynchronous because waiting for a distant Region on every commit would add latency and couple availability. The secondary is therefore behind by some amount, and an unplanned promotion keeps its point in time, which is the data-loss window.",
    followUps: [
      "What does synchronous replication cost in latency?",
      "Can a planned cross-Region switchover reach RPO 0?",
      "What happens if the synchronous standby is slow?",
    ],
    redFlags: [
      "Claims cross-Region replication is synchronous by default.",
      "Ignores commit latency.",
      "Confuses planned switchover with unplanned failover.",
    ],
    rubric: [
      "Explains the synchronous acknowledgement.",
      "Explains asynchronous distance.",
      "Connects lag to RPO.",
      "Distinguishes planned from unplanned.",
    ],
  },
  {
    id: "defend-cost",
    question: "Multi-region costs 3.4x single-AZ. How do you defend or reject that cost?",
    difficulty: 3,
    hints: [
      "Start from the business target, not the architecture.",
      "Compare the cost of the failure with the cost of the copy.",
    ],
    answer:
      "I would tie the spend to a stated failure domain and target: what regional outage the business must survive, the RTO and RPO for that outage, and the revenue or regulatory cost of exceeding them. Then I would compare the incremental cost of the secondary, cross-Region transfer, and drills with the expected loss. If the target only needs AZ tolerance, Multi-AZ is enough. If it needs Region tolerance, the cheaper option is not Multi-AZ; it is accepting a longer RTO or a larger RPO, and that should be an explicit business decision.",
    followUps: [
      "How would a warm standby change the cost?",
      "What is the cost of a drill?",
      "When is backup and restore the right choice?",
    ],
    redFlags: [
      "Chooses multi-region without a target.",
      "Compares only database instance cost.",
      "Ignores the cost of the outage.",
    ],
    rubric: [
      "Starts from the failure domain and targets.",
      "Includes transfer, capacity, and operations.",
      "Compares with the cost of loss.",
      "Makes the tradeoff explicit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Availability, RTO, and RPO are stated per failure domain and per data class.",
      "The topology is mapped to the failure domains it actually survives.",
      "Cross-Region lag is alerted against the RPO.",
      "Recovery-Region capacity is reserved for the full active load.",
      "Promotion, DNS cutover, and application warmup are drilled end to end.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Name the failure domain before choosing a recovery path.",
      "Check whether a writable copy exists outside the failed domain.",
      "Read lag before promoting and choose the least-lagged secondary.",
      "Measure detection, promotion, and application recovery separately.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile lost writes and verify the recovery Region's capacity.",
      "Record the actual RTO and RPO and compare them with the promises.",
      "Fix the slowest step in the runbook, not just the database step.",
      "Update the topology decision with measured cost and downtime.",
    ],
  },
];

const references = [
  {
    title: "Multi-AZ DB instance deployments",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Synchronous standby in another AZ, automatic failover, and the failure domain Multi-AZ covers.",
  },
  {
    title: "Using Amazon Aurora Global Database",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cross-Region secondary clusters, asynchronous storage replication, and promotion.",
  },
  {
    title: "Disaster Recovery of Workloads on AWS",
    url: "https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-workloads-on-aws.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "RTO and RPO definitions, backup and restore, pilot light, warm standby, and multi-site strategies.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "multi-az-vs-region": {
      model: topologyModel,
      presets,
      instructions:
        "Start with the AZ failure preset, then change the failure domain to Region while keeping Multi-AZ. Compare RTO, RPO, availability, and cost, then switch to multi-region. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Recovery times, relative costs, and availability values are teaching values, not AWS guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-cross-region-rpo",
    "databases-aurora-global",
    "databases-dr-drills",
    "databases-failover-dns",
    "reliability-multi-region",
  ],
};
