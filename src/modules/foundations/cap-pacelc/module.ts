import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITE_RPS = 400;
const CONFLICT_SHARE = 0.02;
const STALE_CAP_MS = 10_000;

const params = [
  {
    id: "partition",
    label: "Network partition",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Network",
    help: "Zero connects the regions. One cuts the link and forces the store to choose between consistency and availability.",
    format: "count" as const,
  },
  {
    id: "consistencyMode",
    label: "Consistency mode",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Store policy",
    help: "Zero is strong (wait for the cross-region acknowledgment). One is available (accept local writes). Two is quorum (majority acknowledgment; the model assumes three replicas, two in the surviving region).",
    format: "count" as const,
  },
  {
    id: "crossRegionRtt",
    label: "Cross-region RTT",
    min: 10,
    max: 300,
    step: 10,
    value: 80,
    unit: " ms",
    group: "Network",
    help: "Round-trip time between regions. It becomes write latency whenever a write waits for a remote acknowledgment.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function modeName(mode: number): string {
  if (mode === 1) return "available";
  if (mode === 2) return "quorum";
  return "strong";
}

interface Computed {
  partition: boolean;
  mode: number;
  rtt: number;
  writeLatency: number;
  failedWrites: number;
  conflictRate: number;
  staleness: number;
  availability: number;
}

function compute(p: Params): Computed {
  const partition = num(p, "partition", 0) >= 1;
  const mode = Math.round(clamp(num(p, "consistencyMode", 0), 0, 2));
  const rtt = clamp(num(p, "crossRegionRtt", 80), 10, 300);
  const writeLatency = mode === 1 ? 20 : mode === 2 ? 20 + rtt * 0.3 : 20 + rtt;
  const failedWrites = partition && mode !== 1 ? 50 : 0;
  const conflictRate = partition && mode === 1 ? WRITE_RPS * CONFLICT_SHARE * 60 : 0;
  const staleness = mode === 1 ? (partition ? STALE_CAP_MS : rtt) : 0;
  return {
    partition,
    mode,
    rtt,
    writeLatency,
    failedWrites,
    conflictRate,
    staleness,
    availability: 100 - failedWrites,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seed(frame: SimFrame, values: Record<string, number>): void {
  for (const [id, value] of Object.entries(values)) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.97 + 0.05 * Math.sin((index + 1) / 2.5))),
    );
  }
}

function buildFrame(c: Computed, seedValue: number): SimFrame {
  const latencyHealth = healthFor(c.writeLatency, 150, 300);
  const conflictHealth = healthFor(c.conflictRate, 10, 50);
  const regionBHealth: "ok" | "warn" = c.partition ? "warn" : "ok";
  const regionAHealth = c.partition ? (c.mode === 1 ? conflictHealth : "warn") : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Writers and readers",
        kind: "client",
        health: "ok",
        sublabel: `${WRITE_RPS} writes/s`,
        meta: { view: "flow" },
      },
      {
        id: "region-a",
        label: "Region A",
        kind: "db",
        role: "primary",
        health: regionAHealth,
        utilization: clamp(c.writeLatency / 400),
        sublabel: c.mode === 1 && c.partition ? "accepting local writes" : "primary",
        detail: `Mode ${modeName(c.mode)}. Write latency ${Math.round(c.writeLatency)}ms; conflict rate ${Math.round(c.conflictRate)} per minute.`,
        meta: { view: "flow", lag: 0 },
      },
      {
        id: "region-b",
        label: "Region B",
        kind: "db",
        role: "replica",
        health: regionBHealth,
        utilization: clamp(c.writeLatency / 400),
        sublabel: c.partition ? (c.mode === 1 ? "accepting local writes" : "reads only") : "replica",
        detail: `Read staleness ${Math.round(c.staleness)}ms. During a partition, available mode keeps this region writable and strong mode makes it read-only.`,
        meta: { view: "flow", lag: c.staleness / 1_000 },
      },
      {
        id: "replication",
        label: "Replication link",
        kind: "mesh",
        health: c.partition ? "down" : latencyHealth,
        utilization: c.partition ? 0 : clamp(c.rtt / 300),
        sublabel: c.partition ? "partitioned" : `${Math.round(c.rtt)}ms RTT`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-a", "client", "region-a", 0.8, regionAHealth),
      edge("client-b", "client", "region-b", 0.8, regionBHealth),
      edge("a-b", "region-a", "region-b", c.partition ? 0 : 0.5, c.partition ? "down" : "ok"),
    ],
    metrics: [
      metric("write-latency", "Write latency", c.writeLatency, "ms", 150, 300, "ms"),
      metric("failed-writes", "Failed writes", c.failedWrites, "%", 5, 20, "percent"),
      metric("conflict-rate", "Conflict rate", c.conflictRate, " /min", 10, 50, "count"),
      metric("read-staleness", "Read staleness", c.staleness, "ms", 100, 300, "ms"),
      metric("write-availability", "Write availability", c.availability, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      mode: c.mode,
      partition: c.partition ? 1 : 0,
    },
    summary: `${modeName(c.mode)} mode; ${Math.round(c.writeLatency)}ms writes; ${Math.round(c.failedWrites)}% failed; ${Math.round(c.conflictRate)} conflicts/min; ${c.staleness >= STALE_CAP_MS ? "unbounded" : `${Math.round(c.staleness)}ms`} staleness.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "conflict-rate",
    metricId: "conflict-rate",
    warn: 10,
    crit: 50,
    title: "Both regions are accepting conflicting writes",
    cause:
      "Available mode keeps both sides writable during a partition, so the same key can be updated twice with no ordering. The store now has two versions and must choose or merge them.",
    fix:
      "Choose consistency for the partitioned key space, or add a documented conflict policy such as last-write-wins with a clock, a CRDT, or an application-level merge. Do not let the conflict resolve by accident.",
    checkFirst: [
      "Check whether the write path was available in both regions during the partition.",
      "Check the conflict policy and its clock or version source.",
      "Check which keys were written on both sides and who owns the merge.",
    ],
  },
  {
    id: "read-staleness",
    metricId: "read-staleness",
    warn: 100,
    crit: 300,
    title: "Reads are serving a value older than the freshness contract",
    cause:
      "Asynchronous replication cannot cross the partition. The isolated region reads its last received value, and there is no bound on how old it can become until the link returns.",
    fix:
      "Route freshness-sensitive reads to the majority side, expose staleness to the caller, or switch the read path to a strongly consistent mode. State the bound the product can tolerate.",
    checkFirst: [
      "Check which region served the read and its replication lag.",
      "Check whether the product requires read-your-writes.",
      "Check whether the read path has a fallback to the primary.",
    ],
  },
  {
    id: "write-latency",
    metricId: "write-latency",
    warn: 150,
    crit: 300,
    title: "Consistency is adding cross-region latency to every write",
    cause:
      "Strong mode waits for a remote acknowledgment before it commits. The round-trip time is on the write path, so a distant region or a degraded link becomes write latency even when no partition exists.",
    fix:
      "Keep the write working set in one region, use a quorum whose majority is local, or relax consistency for writes that can tolerate it. Measure the latency cost before choosing the mode.",
    checkFirst: [
      "Compare write latency with the cross-region RTT.",
      "Check whether the write waits for one remote replica or a majority.",
      "Check whether the product needs the write visible in the other region immediately.",
    ],
  },
  {
    id: "failed-writes",
    metricId: "failed-writes",
    warn: 5,
    crit: 20,
    title: "Consistency mode is refusing writes on the minority side",
    cause:
      "Strong and quorum modes refuse writes that cannot reach an acknowledgment quorum. That is the availability cost of avoiding divergence: the minority region cannot make progress.",
    fix:
      "Fail over the minority to a read-only mode with a clear error, or accept the availability loss as the price of consistency. Do not silently accept writes that cannot be ordered.",
    checkFirst: [
      "Check which region is in the minority and whether it still accepts writes.",
      "Check the error returned to clients and whether they retry elsewhere.",
      "Check whether the quorum is local or spans regions.",
    ],
  },
];

export const capModel: SimModel = {
  id: "foundations-cap-pacelc",
  visual: "flow",
  params,
  init: ({ seed: seedValue }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seedValue);
    seed(frame, {
      "write-latency": values.writeLatency,
      "failed-writes": values.failedWrites,
      "conflict-rate": values.conflictRate,
      "read-staleness": values.staleness,
      "write-availability": values.availability,
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      c.partition
        ? `A partition is active. In ${modeName(c.mode)} mode, writes ${c.mode === 1 ? "succeed in both regions" : "fail on the minority side"} and reads are ${c.staleness > 0 ? "stale" : "consistent"}.`
        : `No partition. CAP does not apply; PACELC's else branch does: ${modeName(c.mode)} mode writes take ${Math.round(c.writeLatency)}ms.`,
    );
    if (c.conflictRate > 0) {
      items.push(
        `Conflicts are created at ${Math.round(c.conflictRate)} per minute. The store must resolve them with a policy, not with hope.`,
      );
    }
    items.push(
      `Write latency is ${Math.round(c.writeLatency)}ms and failed writes are ${Math.round(c.failedWrites)}%. Availability and consistency are both visible; one of them paid.`,
    );
    items.push(
      "CAP is a partition-time statement. Using it to describe normal operation is a category error; use PACELC's latency-versus-consistency branch instead.",
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
    description: "No partition, strong mode. Writes pay the 80ms cross-region RTT.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Distant regions",
    description: "A 220ms RTT makes strong writes slow even with a healthy network.",
    tone: "warn",
    params: defaults({ crossRegionRtt: 220 }),
  },
  {
    id: "failure",
    label: "Partition: available",
    description: "Both regions accept writes. Conflicts accumulate and reads go stale.",
    tone: "crit",
    params: defaults({ partition: 1, consistencyMode: 1 }),
  },
  {
    id: "cp",
    label: "Partition: strong",
    description: "The minority side refuses writes. No conflicts, but half the writes fail.",
    tone: "crit",
    params: defaults({ partition: 1, consistencyMode: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The link returns; strong mode serves both regions again.",
    tone: "ok",
    params: defaults(),
  },
];

const experiment: Experiment = {
  id: "predict-available-mode",
  title: "Predict the available-mode outcome",
  simId: "cap",
  question:
    "The link between regions is cut. You switch the store to available mode so both regions keep accepting writes. What happens first?",
  prediction: {
    options: [
      { id: "conflicts", label: "Writes succeed in both regions and conflicting versions accumulate" },
      { id: "failed", label: "Writes fail in the minority region because there is no quorum" },
      { id: "linear", label: "Reads become linearizable because each region is local" },
      { id: "latency", label: "Write latency doubles because the regions still synchronize" },
    ],
    correctOptionId: "conflicts",
    explanation:
      "Available mode chooses local progress over a single consistent order. Both regions accept writes, so the same key can be updated on both sides. Those versions conflict when the link returns. Writes do not fail, reads are not linearizable, and writes do not wait for the remote region; that is the trade being made.",
  },
  setup: defaults({ partition: 1, consistencyMode: 1 }),
  runFor: 12,
  observe: [
    "The conflict rate jumps to 480 per minute as both regions accept writes.",
    "Read staleness is unbounded while the partition lasts.",
    "Failed writes stay at zero because both regions accept local writes.",
    "Write latency is low; availability was preserved and consistency was not.",
  ],
  explain:
    "CAP says that during a partition a distributed store cannot be both linearizable and available for every request. Available mode picks local progress. That is a legitimate choice for a shopping cart or a presence indicator, but it requires a conflict policy and a user-visible notion of merge. Switching to strong mode removes conflicts by refusing the minority's writes; that is the other side of the same trade.",
  fix: defaults({ partition: 1, consistencyMode: 0 }),
  debrief:
    "Strong mode during the partition produces zero conflicts and 50% failed writes. Available mode produces zero failed writes and a conflict rate of 480 per minute. Neither is correct in the abstract. The right choice depends on the operation: a cart can merge, a balance transfer cannot. Name the conflict policy before the partition, not during it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "CAP, for consistency, availability, and partition tolerance, is a statement about a distributed store during a network partition. It says the store cannot guarantee both linearizability and availability for every request while the partition lasts. Partition tolerance is not a third optional feature; a network that can drop messages forces the choice. A consistency-preferring (CP) store refuses some requests to preserve one consistent order. An availability-preferring (AP) store accepts local requests and reconciles divergent versions later.",
  },
  {
    type: "p",
    text: "PACELC names the two branches: on a Partition, choose Availability or Consistency; Else, choose Latency or Consistency. Strong replication across regions puts the round-trip time on the write path even when the network is healthy. That is the everyday cost that CAP alone does not describe.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The choice belongs to the data operation, not to the company. A balance transfer needs a single order and can refuse writes during a partition. A shopping cart can accept writes in both regions and merge them. A product catalog may prefer low-latency reads and tolerate bounded staleness. One application can use different modes for different keys or endpoints, as long as the conflict policy is explicit.",
  },
  {
    type: "table",
    headers: ["Mode", "During a partition", "Normal-case cost", "Needs a conflict policy"],
    rows: [
      ["Strong (CP)", "Minority refuses writes", "Cross-region acknowledgment on writes", "No, but availability is lost"],
      ["Available (AP)", "Both sides accept writes", "Local writes, asynchronous replication", "Yes, before the partition"],
      ["Quorum (CP)", "Majority side serves; minority fails", "Majority acknowledgment, often local", "No, but quorum placement matters"],
      ["Read from replica (AP reads)", "Isolated reads may be stale", "Replication lag bounds freshness", "Usually not for reads, but the product must tolerate staleness"],
    ],
  },
  {
    type: "p",
    text: "A quorum needs an odd number of replicas. This model assumes three replicas with two in the surviving region after a link failure; that side has a majority and can keep serving. With exactly one replica per region, neither side has a majority when the link is cut, so quorum placement is the difference between a working minority and a full write outage.",
  },
  {
    type: "p",
    text: "This module models a two-region store with 400 writes per second and a configurable cross-region RTT. A conflict rate of 2% is illustrative. The numbers are teaching values; the shape is the lesson. Writes either wait for a remote acknowledgment, fail on the minority side, or proceed locally and create versions to reconcile.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Write latency: the PACELC cost of waiting for a cross-region acknowledgment.",
      "Failed writes: the availability price of strong or quorum mode during a partition.",
      "Conflict rate: the consistency debt of available mode while both sides write.",
      "Read staleness: how old the isolated region's data can be, bounded only by the link's return.",
      "Write availability: the complement of failed writes, shown beside the consistency signals.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Distant regions to see the PACELC else branch. Apply Partition: available and watch the conflict rate and staleness while failed writes stay at zero. Switch to Partition: strong with the same link failure and compare failed writes. Run the experiment before reading the explanation. The point is not which mode is better; it is which promise you are willing to break.",
  },
  { type: "sim", simId: "cap" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With the link healthy, strong writes waited 100ms for the 80ms round trip. When the partition was applied, available mode kept both regions writable: failed writes stayed at zero and write latency fell to 20ms, but the same keys were updated on both sides and conflicts were created at 480 per minute. Read staleness in the isolated region became unbounded for the duration of the partition.",
  },
  {
    type: "p",
    text: "Strong mode with the same partition made the minority read-only. Conflicts stayed at zero and reads stayed consistent, but half the writes failed. Neither result is a bug. They are two different promises: available mode preserves local progress and creates reconciliation work; strong mode preserves a single order and gives up availability on one side.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database metrics: replication lag, conflict counts, quorum failures, write latency, and the ratio of writes served by each region.",
      "Client metrics: write errors split by region, retries to the other region, and read-your-writes violations.",
      "Application logs: merge decisions, last-write-wins timestamps, and keys that changed in both regions.",
      "Traces: a write span waiting on a remote acknowledgment, or failing immediately with a quorum error.",
      "Business signals: duplicate or lost updates, cart merges, and customer-visible inconsistencies.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether a partition is actually active before invoking CAP. Then check the mode and the quorum placement: which region can still reach a majority, and which side is refusing writes. For available mode, check the conflict rate and the merge policy, not only write success. For strong mode, check failed writes and the latency added by the remote acknowledgment.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify each data operation by the promise it needs: a single order, local progress, or bounded staleness.",
      "Choose the mode per operation and write down the failure behavior before the partition.",
      "For available mode, design the conflict policy and the merge UX; test it with concurrent writes on both sides.",
      "For strong or quorum mode, place the quorum so the surviving side can make progress and return a clear error on the minority.",
      "Measure the normal-case latency cost of consistency; a cross-region RTT is on every write that waits for it.",
      "Game-day the partition and verify that reads, writes, and merges behave as documented.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Available mode keeps writes flowing and creates conflicts that must be merged; some merges lose data or require user resolution.",
      "Strong mode avoids conflicts and refuses writes on the minority side; the business must accept that availability loss.",
      "Quorum mode can reduce latency when the majority is local, but the quorum placement decides which region survives a partition.",
      "Cross-region strong consistency puts RTT on every write, which is a capacity and user-experience cost even without a failure.",
      "CAP does not choose for you. A slogan is not a conflict policy; the operation and the user promise decide.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "apply-cap",
    question:
      "A candidate says their database is CA. How do you respond?",
    difficulty: 2,
    hints: [
      "Partition tolerance is about the network, not the database vendor.",
      "CAP applies during a partition.",
    ],
    answer:
      "I would ask what happens when the network drops messages between replicas. A distributed store cannot opt out of partitions, so CA is not a useful description for a replicated system. During a partition it must choose consistency or availability for the affected requests, or refuse to make progress. A single-node database can be consistent and available because there is no partition to tolerate, but that is not the same claim. I would redirect the conversation to the operation's behavior during a partition and its normal-case latency cost.",
    followUps: [
      "What does CP actually sacrifice?",
      "Can a system be AP for one endpoint and CP for another?",
      "Where does PACELC fit?",
    ],
    redFlags: [
      "Accepts CA for a replicated store.",
      "Treats partition tolerance as optional.",
      "Recites CAP without an operation.",
    ],
    rubric: [
      "Defines partition tolerance.",
      "Explains the forced choice.",
      "Distinguishes single-node from replicated.",
      "Moves to PACELC or operation-level behavior.",
    ],
  },
  {
    id: "choose-mode",
    question:
      "How do you choose between strong and available mode for a shopping cart and a balance transfer?",
    difficulty: 3,
    hints: [
      "Start from the cost of a wrong answer.",
      "A merge is a product behavior, not only a database setting.",
    ],
    answer:
      "For a balance transfer, a conflicting write can move money twice or lose a debit, so I would choose strong or quorum consistency and refuse writes on the side that cannot reach a quorum. The user sees an error, which is safer than a silent double spend. For a shopping cart, both sides can accept writes and merge by item, because the product can present a combined cart and the cost of a temporary divergence is low. In both cases I would write down the conflict policy and the user-visible failure, then test the partition. The mode follows the operation's promise, not a preference for availability.",
    followUps: [
      "What would you do for a catalog read?",
      "How does the merge policy affect the UX?",
      "What if the cart merge also changes price?",
    ],
    redFlags: [
      "Picks AP for everything because it is always available.",
      "Picks CP for everything because it is safer.",
      "Has no conflict policy.",
    ],
    rubric: [
      "Ties the choice to the cost of a wrong answer.",
      "Names the failure the user sees.",
      "Designs the conflict policy.",
      "Tests the partition.",
    ],
  },
  {
    id: "pacelc-normal",
    question:
      "There is no partition. Why is strong consistency still costly?",
    difficulty: 2,
    hints: [
      "The acknowledgment has to travel.",
      "PACELC's else branch.",
    ],
    answer:
      "Strong consistency requires the write to be ordered with respect to other writes, which usually means waiting for an acknowledgment from another replica or a quorum. If that replica is in another region, the round-trip time is added to every write. That lowers throughput per connection and raises p99, even though the network is healthy. PACELC captures this as latency versus consistency in the normal case. The alternatives are to keep the quorum local, relax consistency for operations that can tolerate it, or accept the latency because the operation needs a single order.",
    followUps: [
      "How does quorum placement change the cost?",
      "When would you choose asynchronous replication?",
      "What does 'locally linearizable' mean?",
    ],
    redFlags: [
      "Says CAP explains normal latency.",
      "Ignores the acknowledgment path.",
      "Assumes replication is free.",
    ],
    rubric: [
      "Names the acknowledgment cost.",
      "Connects it to PACELC.",
      "Offers quorum placement or relaxation.",
      "Keeps the operation's promise in view.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each data operation has a documented consistency and availability promise.",
      "The conflict policy exists for every available-mode write path.",
      "Quorum placement and minority behavior are tested.",
      "Normal-case write latency includes the cross-region acknowledgment cost.",
      "Dashboards separate conflicts, failed writes, and read staleness.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the partition before invoking CAP.",
      "Check which side can reach a quorum and which side is refusing writes.",
      "For available mode, watch conflict growth and the merge path.",
      "For strong mode, watch failed writes and client retries to the other region.",
      "Record the mode and the user-visible failure for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile divergent versions and verify the merge result.",
      "Replay the partition against the documented policy.",
      "Review whether the mode matched the operation's promise.",
      "Revisit quorum placement or latency budgets if the cost was unexpected.",
    ],
  },
];

const references = [
  {
    title: "Brewer's conjecture and the feasibility of consistent, available, partition-tolerant web services",
    url: "https://www.comp.nus.edu.sg/~gilbert/pubs/BrewersConjecture-SigAct.pdf",
    publisher: "ACM SIGACT News, 2002",
    kind: "standard" as const,
    note: "The formal CAP result and its definitions of consistency and availability.",
  },
  {
    title: "Consistency tradeoffs in modern distributed database system design",
    url: "https://www.cs.umd.edu/~abadi/papers/abadi-pacelc.pdf",
    publisher: "IEEE Computer, 2012",
    kind: "standard" as const,
    note: "PACELC: the partition choice and the normal-case latency-versus-consistency choice.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    cap: {
      model: capModel,
      presets,
      instructions:
        "Start healthy, apply Distant regions, then compare Partition: available with Partition: strong. Watch the conflict rate, failed writes, and staleness together; no mode makes all three healthy.",
      experimentIds: [experiment.id],
      alternateVisuals: ["replication"],
      note: "Illustrative model. Write rate, conflict share, and RTT values are teaching figures, not a database guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-use-red",
    "foundations-consistency-models",
    "databases-cross-region-rpo",
  ],
};
