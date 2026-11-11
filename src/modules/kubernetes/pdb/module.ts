import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "replicas",
    label: "Desired replicas",
    min: 1,
    max: 12,
    step: 1,
    value: 6,
    unit: " pods",
    group: "Workload",
    help: "Pods the controller wants. The PDB budget is measured against this number, so changing it changes the meaning of the budget.",
    format: "count",
  },
  {
    id: "minAvailable",
    label: "minAvailable",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "PDB",
    help: "Share of desired replicas that must stay healthy. maxUnavailable is the complement, so a 50% minimum allows up to half the pods to be disrupted.",
    format: "percent",
  },
  {
    id: "drainBatch",
    label: "Pods to evict",
    min: 0,
    max: 4,
    step: 1,
    value: 1,
    unit: " pods",
    group: "Maintenance",
    help: "Evictions requested by a node drain or another voluntary disruption. The eviction API rejects requests that would violate the budget.",
    format: "count",
  },
  {
    id: "unready",
    label: "Pods not ready",
    min: 0,
    max: 6,
    step: 1,
    value: 0,
    unit: " pods",
    group: "Workload",
    help: "Pods that exist but are not ready. They consume the desired count but do not count as healthy, so they reduce the disruption budget before the drain starts.",
    format: "count",
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
  replicas: number;
  minAvailable: number;
  drainBatch: number;
  unready: number;
  desiredHealthy: number;
  healthy: number;
  allowed: number;
  evictions: number;
  available: number;
  gap: number;
  denied: number;
  drainProgress: number;
}

function compute(p: Params): Computed {
  const replicas = Math.round(clamp(num(p, "replicas", 6), 1, 12));
  const minAvailable = Math.round(clamp(num(p, "minAvailable", 50), 0, 100));
  const drainBatch = Math.round(clamp(num(p, "drainBatch", 1), 0, 4));
  const unready = Math.round(clamp(num(p, "unready", 0), 0, Math.min(6, replicas)));
  const desiredHealthy = Math.ceil((replicas * minAvailable) / 100);
  const healthy = replicas - unready;
  const allowed = Math.max(0, healthy - desiredHealthy);
  const evictions = Math.min(drainBatch, allowed);
  const available = healthy - evictions;
  return {
    replicas,
    minAvailable,
    drainBatch,
    unready,
    desiredHealthy,
    healthy,
    allowed,
    evictions,
    available,
    gap: ((replicas - available) / replicas) * 100,
    denied: drainBatch - evictions,
    drainProgress: drainBatch > 0 ? (evictions / drainBatch) * 100 : 100,
  };
}

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(values: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return values.reduce<Health>((best, value) => (rank[value] > rank[best] ? value : best), "ok");
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const gapHealth = healthFor(values.gap, 20, 60);
  const deniedHealth = healthFor(values.denied, 1, 2);
  const workloadHealth = worst([gapHealth, deniedHealth]);
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout service",
      kind: "service",
      health: workloadHealth,
      utilization: clamp((values.available / values.replicas)),
      sublabel: `${values.available} of ${values.replicas} pods serving`,
      detail: `${values.available} pods are available after ${values.evictions} eviction${values.evictions === 1 ? "" : "s"}. The PDB requires ${values.desiredHealthy} healthy pods.`,
      meta: { view: "flow" },
    },
    {
      id: "pdb",
      label: "PodDisruptionBudget",
      kind: "service",
      health: values.denied > 0 ? "warn" : "ok",
      sublabel: `minAvailable ${values.minAvailable}% · ${values.allowed} allowed`,
      detail: `Desired healthy is ${values.desiredHealthy} of ${values.replicas}. With ${values.healthy} healthy now, the eviction API permits ${values.allowed} voluntary disruption${values.allowed === 1 ? "" : "s"}.`,
      meta: { view: "flow" },
    },
    {
      id: "pods",
      label: "replica pods",
      kind: "service",
      role: "instance",
      health: gapHealth,
      utilization: clamp(values.available / values.replicas),
      sublabel: `${values.available} available · ${values.unready} unready`,
      detail: `${values.healthy} pods are healthy before the drain; ${values.unready} exist but do not count. The PDB compares healthy pods, not pod objects.`,
      meta: { view: "flow" },
    },
    {
      id: "drain",
      label: "node drain",
      kind: "worker",
      health: values.denied > 0 ? "warn" : "ok",
      sublabel: `${values.evictions} evicted · ${values.denied} denied`,
      detail:
        values.denied > 0
          ? `The drain asked to evict ${values.drainBatch} pods but the budget stopped ${values.denied}. The node cannot be drained until a pod becomes healthy or the budget changes.`
          : `The drain evicted ${values.evictions} of ${values.drainBatch} requested pods.`,
      meta: { view: "flow" },
    },
  ];
  return {
    t: 0,
    nodes,
    edges: [
      edge("service-pods", "service", "pods", clamp(values.available / values.replicas), gapHealth),
      edge("pdb-pods", "pdb", "pods", clamp(values.allowed / values.replicas), values.denied > 0 ? "warn" : "ok"),
      edge("drain-pods", "drain", "pods", values.drainBatch > 0 ? values.evictions / values.drainBatch : 0, values.denied > 0 ? "warn" : "ok"),
    ],
    metrics: [
      metric("availability-gap", "Unavailable share", values.gap, "%", 20, 60, "percent"),
      metric("unready-pods", "Unready pods", values.unready, "", 1, 3, "count"),
      metric("evictions-denied", "Evictions denied by PDB", values.denied, "", 1, 2, "count"),
      metric("available-pods", "Available pods", values.available, "", undefined, undefined, "count"),
      metric("allowed-disruptions", "Allowed disruptions", values.allowed, "", undefined, undefined, "count"),
      metric("drain-progress", "Drain progress", values.drainProgress, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, minAvailable: values.minAvailable, drainBatch: values.drainBatch },
    summary: `${values.available} of ${values.replicas} pods available; ${values.allowed} disruptions allowed by the PDB; ${values.evictions} evicted, ${values.denied} denied.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 4)) / 2.5);
  const entries: [string, number, number][] = [
    ["availability-gap", values.gap, 0],
    ["unready-pods", values.unready, 0],
    ["evictions-denied", values.denied, 0],
    ["available-pods", values.available, 0],
    ["allowed-disruptions", values.allowed, 0],
    ["drain-progress", values.drainProgress, 0],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "availability-gap",
    metricId: "availability-gap",
    warn: 20,
    crit: 60,
    title: "Availability gap after the drain",
    cause:
      "The drain removed pods and reduced availability. When the remaining healthy pods sit exactly at the floor, the PDB is doing its job; the gap is a policy problem only when the floor is too low for the service target or readiness was already poor. The PDB protects voluntary disruptions against its own budget; it does not guarantee a service-level availability target.",
    fix:
      "If pods are unready, restore readiness. If the floor is too low for the service target, add replicas or review minAvailable. If the floor is correct, the drain stopped where it should and further eviction waits for a healthy pod or added capacity.",
    checkFirst: [
      "Compute desired healthy from replicas and minAvailable, then compare it with the pods that are actually ready.",
      "Check whether unready pods or the configured floor caused the remaining availability.",
      "Check whether the service can serve traffic with the pods that remain after the drain.",
    ],
  },
  {
    id: "unready-pods",
    metricId: "unready-pods",
    warn: 1,
    crit: 3,
    title: "Unready pods are consuming the disruption budget",
    cause:
      "A PDB counts healthy, ready pods. Pods that exist but fail readiness lower the current healthy count without lowering the desired count, so the allowed disruptions shrink before maintenance starts.",
    fix:
      "Restore readiness first: check probe failures, slow starts, and dependency errors. Raising the budget or bypassing eviction does not make an unready pod serve traffic.",
    checkFirst: [
      "Read pod conditions and the readiness probe result.",
      "Compare pods that exist with pods that are ready.",
      "Check whether a dependency or recent rollout made the pods unready.",
    ],
  },
  {
    id: "evictions-denied",
    metricId: "evictions-denied",
    warn: 1,
    crit: 2,
    title: "The drain is blocked by the disruption budget",
    cause:
      "The eviction API rejects a request when the number of healthy pods would fall below the budget. Unready pods reduce the current healthy count without reducing the desired count, so a workload can be at its budget before maintenance begins.",
    fix:
      "Restore readiness first; a pod that is running but not ready consumes the budget. If the workload is intentionally at its minimum, raise the replica count so the budget has room, or change the budget after reviewing the availability target. Do not bypass eviction unless you accept the availability loss.",
    checkFirst: [
      "Check why pods are unready: probe failures, slow starts, or a dependency problem.",
      "Compare current healthy pods with the PDB's desired healthy value.",
      "Check the drain event for the eviction denial message.",
    ],
  },
];

function defaultsFor(id: string): Params {
  if (id === "peak") {
    return defaults({ replicas: 8, minAvailable: 67, drainBatch: 2, unready: 1 });
  }
  if (id === "failure") {
    return defaults({ replicas: 6, minAvailable: 0, drainBatch: 4, unready: 0 });
  }
  if (id === "recovery") {
    return defaults({ replicas: 12, minAvailable: 50, drainBatch: 2, unready: 0 });
  }
  return defaults({ replicas: 6, minAvailable: 50, drainBatch: 1, unready: 0 });
}

export const pdbModel: SimModel = {
  id: "kubernetes-pdb",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.summary = `${values.available} of ${values.replicas} pods available; ${values.allowed} disruptions allowed by the PDB; ${values.evictions} evicted, ${values.denied} denied.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Desired healthy is ${values.desiredHealthy} of ${values.replicas} pods. With ${values.healthy} healthy, the PDB allows ${values.allowed} voluntary disruption${values.allowed === 1 ? "" : "s"}.`,
      values.denied > 0
        ? `The drain requested ${values.drainBatch} evictions and ${values.denied} were denied. The PDB is doing its job: it is refusing to take the service below its budget.`
        : `The drain evicted ${values.evictions} pod${values.evictions === 1 ? "" : "s"} without exceeding the budget.`,
      `Availability after the drain is ${(100 - values.gap).toFixed(0)}%. The PDB compares healthy pods with minAvailable; it does not measure request latency, queue depth, or dependency health.`,
      values.minAvailable === 0
        ? "A minAvailable of zero allows every healthy pod to be evicted. The object exists, but it provides no availability guarantee."
        : `maxUnavailable is effectively ${100 - values.minAvailable}%: the budget is a floor on healthy pods, not a ceiling on the drain batch.`,
    ];
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Drain blocked", tone: "warn" },
    { label: "Availability lost", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Six ready pods, a 50% floor, and one pod draining.",
    tone: "ok",
    params: defaultsFor("healthy"),
  },
  {
    id: "peak",
    label: "Budget tight",
    description: "One pod is unready, so a two-pod drain is cut to one eviction.",
    tone: "warn",
    params: defaultsFor("peak"),
  },
  {
    id: "failure",
    label: "No floor",
    description: "minAvailable is zero, so a four-pod drain leaves only two replicas.",
    tone: "crit",
    params: defaultsFor("failure"),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Twelve replicas give the 50% floor enough room for a two-pod drain.",
    tone: "ok",
    params: defaultsFor("recovery"),
  },
];

const experiment: Experiment = {
  id: "predict-blocked-drain",
  title: "Predict what the eviction API does when a pod is unready",
  simId: "pdb",
  question:
    "Six pods, minAvailable 50%, two unready pods, and a drain that asks to evict two. What happens?",
  prediction: {
    options: [
      { id: "all", label: "Both evictions succeed because six pod objects exist" },
      { id: "one", label: "One eviction succeeds, then the drain blocks at the budget" },
      { id: "none", label: "No eviction succeeds because the PDB is already violated" },
      { id: "delete", label: "The PDB is deleted automatically so the drain can finish" },
    ],
    correctOptionId: "one",
    explanation:
      "The PDB compares current healthy pods with desired healthy, not pod objects with replicas. Four pods are healthy and the 50% floor requires three, so only one disruption is allowed. The first eviction succeeds, the second is denied, and the drain waits for a pod to become ready or for the budget to change.",
  },
  setup: defaults({ replicas: 6, minAvailable: 50, drainBatch: 2, unready: 2 }),
  runFor: 20,
  observe: [
    "Two unready pods reduce healthy pods to four before the drain starts.",
    "The PDB allows one disruption, not two.",
    "One eviction completes, one is denied, and the drain is blocked.",
    "Availability after the eviction is three of six pods, which is exactly the floor.",
  ],
  explain:
    "A disruption budget is a statement about healthy pods at the moment of eviction. Pods that exist but fail readiness do not count, so a workload can enter maintenance with less budget than its replica count suggests. The eviction API enforces the budget one request at a time; it does not reserve headroom for the whole drain. That is why a drain that looks safe on a replica count can block after the first eviction.",
  fix: defaults({ replicas: 6, minAvailable: 50, drainBatch: 1, unready: 0 }),
  debrief:
    "Restoring readiness returns the budget to three allowed disruptions, and a one-pod drain completes with five pods serving. The budget did not change; the healthy count did. That is the signal to check first when a drain blocks during an incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A PodDisruptionBudget, or PDB, limits voluntary disruptions for a group of pods. A voluntary disruption is an action that can be postponed, such as draining a node for maintenance, evicting a pod during a cluster upgrade, or descheduling a workload. The PDB does not prevent node failures, kernel panics, OOM kills, or a pod being deleted outside the eviction API. It governs the eviction API, which is the path well-behaved maintenance uses.",
  },
  {
    type: "p",
    text: "A PDB sets either minAvailable or maxUnavailable. minAvailable is a floor: at least that many pods must remain healthy. maxUnavailable is a ceiling: at most that many may be unavailable. Both can be integers or percentages, but a single PDB must use one of the two fields. The eviction API computes the current healthy count from readiness, compares it with the budget, and rejects the request when the disruption would violate it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The PDB sits between the workload controller and the maintenance operation. The controller owns replicas and readiness; the PDB owns the permission to disrupt them; the drain owns the node. Each layer has a different failure mode. A PDB with a low floor permits too much loss during a drain. A PDB with a high floor blocks maintenance when readiness is already poor. Neither outcome is a PDB bug; both are consequences of the budget and the current state.",
  },
  {
    type: "table",
    headers: ["Event", "Does the PDB apply?", "What protects availability"],
    rows: [
      ["Node drain for maintenance", "Yes, through the eviction API", "Replicas, readiness, budget, spare capacity"],
      ["Cluster upgrade eviction", "Yes, through the eviction API", "Budget and replacement capacity"],
      ["Node failure", "No", "Replicas on other nodes and failover"],
      ["OOM kill or crash", "No", "Restart policy and readiness"],
    ],
  },
  {
    type: "compare",
    leftTitle: "minAvailable",
    rightTitle: "maxUnavailable",
    rows: [
      { label: "Shape", left: "Floor on healthy pods", right: "Ceiling on unavailable pods" },
      { label: "At 50% of 6", left: "At least 3 healthy", right: "At most 3 unavailable" },
      { label: "During a drain", left: "Stops before the floor is crossed", right: "Stops before the ceiling is crossed" },
      { label: "Common mistake", left: "Setting 100% and blocking all drains", right: "Setting a value that permits all pods" },
    ],
  },
  {
    type: "p",
    text: "This module models six to twelve replicas, a percentage budget, and a drain batch of up to four pods. The replica counts and percentages are illustrative. The mechanic is the one that matters: the PDB evaluates healthy pods, so unready pods consume the budget before the drain begins.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Desired healthy pods, current healthy pods, and the disruptions the PDB allows.",
      "Pods that exist but are unready, which lower the healthy count without lowering the desired count.",
      "A drain that completes, blocks, or removes availability, with the eviction count at each step.",
      "The availability gap and the denied evictions as separate signals.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the allowed disruption count. Apply Budget tight: one unready pod cuts a two-pod drain to one eviction. Then apply No floor and see why a PDB with minAvailable zero still permits half the service to disappear. Run the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "pdb" },
  {
    type: "p",
    text: "The question to ask before a drain is not how many pods exist. It is how many are healthy right now, how many the budget requires, and how many the workload can lose without breaching its own availability target. Those three numbers can disagree. A PDB only encodes the second one.",
  },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Two unready pods reduced the healthy count from six to four. The 50% floor required three healthy pods, so the PDB allowed only one disruption. The first eviction succeeded, the second was denied, and the drain waited. The replica count still said six, which made the workload look larger than the availability it actually had. The budget was correct; the readiness was the problem.",
  },
  {
    type: "p",
    text: "The No floor preset showed the opposite failure. With minAvailable at zero, the PDB allowed the drain to remove half the replicas. The object was present and technically satisfied, but it protected nothing. A PDB is only as meaningful as the floor it encodes.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl get pdb: minAvailable or maxUnavailable, allowed disruptions, and current healthy pods.",
      "kubectl describe pdb and the drain output: the eviction denial and the pod that could not be removed.",
      "Pod readiness: probe failures, slow starts, and dependency errors that reduce the healthy count.",
      "Node drain events and the maintenance window, which show whether the block is expected.",
      "Service capacity: whether the remaining pods can serve the traffic after each eviction.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare current healthy pods with desired healthy, then check why any pod is unready. If the workload is intentionally at its floor, add replicas before draining. If the floor is too low, raise it before the next maintenance window. Do not disable eviction to force a drain unless you have accepted the availability loss.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the PDB's allowed disruptions and compare it with the current healthy count.",
      "Find why pods are unready and restore readiness before retrying the drain.",
      "Choose minAvailable from the availability target and the capacity of the remaining pods.",
      "Raise replicas or add spare capacity if maintenance must proceed at the current floor.",
      "Drain in small batches and verify ready pods between batches.",
      "Confirm the PDB still permits routine maintenance after the incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A high minAvailable protects availability but can block upgrades and leave nodes undrained.",
      "A low minAvailable keeps maintenance easy but may allow more loss than the service can absorb.",
      "A percentage budget scales with replica count but changes meaning when the count changes.",
      "A 100% floor makes drains impossible without a second replica set or temporary capacity.",
      "A PDB adds safety for voluntary work but does nothing for a node failure or a crash loop.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "pdb-guarantee",
    question:
      "A team says the PDB guarantees 99.9% availability. What is wrong with that statement?",
    difficulty: 2,
    hints: [
      "A PDB counts healthy pods, not requests.",
      "It applies to voluntary disruptions only.",
    ],
    answer:
      "A PDB constrains voluntary evictions so the healthy pod count stays above a floor or the unavailable count stays below a ceiling. It does not measure request success, latency, or dependency health, and it does not apply to node failures, crashes, or OOM kills. A service can satisfy its PDB and still fail every request because the remaining pods depend on a broken database. The 99.9% number belongs to an SLO with an error budget, not to a PDB.",
    followUps: [
      "What does a PDB guarantee during a node failure?",
      "How would you connect a PDB to an availability target?",
      "What happens when every pod is unready?",
    ],
    redFlags: [
      "Treats the PDB as an SLO.",
      "Assumes it covers all failures.",
      "Ignores request success.",
    ],
    rubric: [
      "Defines the PDB as a voluntary-disruption control.",
      "Separates pod health from request health.",
      "Names failures the PDB does not cover.",
      "Connects availability to an SLO.",
    ],
  },
  {
    id: "drain-blocked",
    question:
      "A node drain is blocked during an incident. What do you check, and when would you bypass it?",
    difficulty: 3,
    hints: [
      "Start with healthy pods against desired healthy.",
      "Bypassing eviction is an availability decision.",
    ],
    answer:
      "I check the PDB's allowed disruptions, the current healthy count, and why pods are unready. If the workload is at its floor because of probe failures, I fix readiness first. If the floor is intentionally high and maintenance cannot wait, I add replicas or temporarily lower the budget after confirming the service can tolerate the loss. I would only bypass eviction with explicit acceptance of the availability risk, because it removes the protection the PDB was providing. During an incident I would also ask whether the drain itself is causing the problem and stop it if so.",
    followUps: [
      "How would you add capacity before the drain?",
      "What is the risk of lowering minAvailable during an incident?",
      "How do you verify the service after each eviction?",
    ],
    redFlags: [
      "Disables eviction immediately.",
      "Ignores unready pods.",
      "Changes the PDB without an availability decision.",
    ],
    rubric: [
      "Checks healthy count and readiness.",
      "Restores readiness first.",
      "Treats bypass as a risk decision.",
      "Verifies capacity between evictions.",
    ],
  },
  {
    id: "choose-budget",
    question:
      "How do you choose minAvailable for a six-replica service that must survive one node loss?",
    difficulty: 3,
    hints: [
      "One node loss is not a voluntary disruption, but it consumes the same replicas.",
      "Think about capacity, not only pod count.",
    ],
    answer:
      "I start from the capacity the service needs at peak and the number of replicas that can serve it. If one node holds two of six replicas, a node loss leaves four. A minAvailable of four would preserve the pod count but might still leave the remaining pods over capacity. I would choose the floor from a load test, then check that the budget still allows routine drains. If one node loss is a hard requirement, I might need more replicas or better spreading so the loss does not remove so much capacity. The PDB does not protect against the node failure; it only governs the drain.",
    followUps: [
      "How does topology spread change the answer?",
      "What would make you use maxUnavailable instead?",
      "How do you test the budget before relying on it?",
    ],
    redFlags: [
      "Picks a percentage without checking capacity.",
      "Assumes the PDB covers node loss.",
      "Ignores how pods are spread across nodes.",
    ],
    rubric: [
      "Derives the floor from capacity.",
      "Accounts for node placement.",
      "Keeps drains possible.",
      "Distinguishes voluntary from involuntary.",
    ],
  },
  {
    id: "unready-budget",
    question:
      "Why can a workload be at its PDB floor before any maintenance starts?",
    difficulty: 2,
    hints: [
      "The desired count and the healthy count are different.",
      "Readiness is part of the budget.",
    ],
    answer:
      "The PDB compares current healthy pods with desired healthy, which is derived from the desired replica count and the budget. Pods that are running but not ready count toward the desired replicas only if the controller still considers them part of the set; they do not count as healthy. A failed readiness probe, a slow start, or a broken dependency can therefore consume the entire disruption budget. The fix is to restore readiness, not to lower the budget, unless the service can genuinely operate with fewer healthy pods.",
    followUps: [
      "What happens if readiness flaps?",
      "How would you alert on budget exhaustion before a drain?",
      "Should a PDB count terminating pods?",
    ],
    redFlags: [
      "Confuses pod objects with healthy pods.",
      "Lowers the budget as the first response.",
      "Ignores probe behavior.",
    ],
    rubric: [
      "Distinguishes desired from healthy.",
      "Names readiness as the cause.",
      "Restores readiness first.",
      "Explains the budget consequence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each critical workload has a PDB whose floor is derived from capacity, not from habit.",
      "Readiness probes reflect the ability to serve, so unready pods do not silently consume the budget.",
      "The team knows which node drains are routine and how many disruptions they need.",
      "Replica count and topology spread are sufficient for the maintenance pattern.",
      "A dashboard shows allowed disruptions and healthy pods beside the PDB configuration.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare current healthy pods with the PDB's desired healthy value.",
      "Find why pods are unready before changing the budget.",
      "Check whether the drain is the cause or a casualty of the incident.",
      "Add capacity or reduce the drain batch if maintenance must proceed.",
      "Record every bypass of eviction and the availability risk it accepted.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Revisit minAvailable with the measured capacity of the remaining pods.",
      "Fix readiness gaps that consumed the budget.",
      "Keep the drain batch aligned with the allowed disruptions.",
      "Test a drain in a staging cluster with the real PDB and replica count.",
    ],
  },
];

const references = [
  {
    title: "Disruptions",
    url: "https://kubernetes.io/docs/concepts/workloads/pods/disruptions/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Voluntary and involuntary disruptions, and how PDBs are evaluated.",
  },
  {
    title: "Specifying a Disruption Budget for your Application",
    url: "https://kubernetes.io/docs/tasks/run-application/configure-pdb/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "minAvailable, maxUnavailable, and the eviction API.",
  },
  {
    title: "Safely Drain a Node",
    url: "https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "How kubectl drain uses eviction and respects disruption budgets.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    pdb: {
      model: pdbModel,
      presets,
      instructions:
        "Start Healthy and note the allowed disruptions. Apply Budget tight, then No floor. Compare the drain result with the PDB floor before trying Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Replica counts, budget percentages, and drain batches are teaching values, not a cluster policy.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-pods-deployments",
    "kubernetes-scheduling",
    "kubernetes-upgrades",
    "foundations-capacity-headroom",
  ],
};
