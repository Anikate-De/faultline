import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZ_COUNT = 3;

const params = [
  {
    id: "replicas",
    label: "Data replicas",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: " copies",
    group: "Topology",
    help: "Copies of the data. A single copy makes the data unavailable whenever its zone fails.",
    format: "count" as const,
  },
  {
    id: "sharedDependency",
    label: "Pinned dependency",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Correlation",
    help: "Share of requests that depend on a component located in one zone, such as a cache, queue, or identity service. It is a single failure domain wearing a shared name.",
    format: "percent" as const,
  },
  {
    id: "failureType",
    label: "Failure scope",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Zero is no failure. One is a zone failure. Two is a rack failure inside one zone. Three is a deployment that reaches every instance at once.",
    format: "count" as const,
  },
  {
    id: "rackSpread",
    label: "Racks per zone",
    min: 1,
    max: 4,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "Racks across which instances are spread in each zone. More racks reduce the capacity lost to one rack failure but do not fix a shared dependency.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function failureName(failureType: number): string {
  if (failureType === 1) return "Zone failure";
  if (failureType === 2) return "Rack failure";
  if (failureType === 3) return "Fleet-wide deploy";
  return "No failure";
}

interface Computed {
  azCount: number;
  replicas: number;
  sharedDependency: number;
  failureType: number;
  rackSpread: number;
  capacityLoss: number;
  dataRisk: number;
  blastRadius: number;
  availability: number;
  correlation: number;
}

function compute(p: Params): Computed {
  const azCount = AZ_COUNT;
  const replicas = Math.max(1, Math.round(num(p, "replicas", 3)));
  const sharedDependency = clamp(num(p, "sharedDependency", 0), 0, 100);
  const failureType = Math.round(clamp(num(p, "failureType", 0), 0, 3));
  const rackSpread = Math.max(1, Math.round(num(p, "rackSpread", 1)));
  let capacityLoss = 0;
  if (failureType === 1) capacityLoss = 100 / azCount;
  if (failureType === 2) capacityLoss = 100 / (azCount * rackSpread);
  if (failureType === 3) capacityLoss = 100;
  const dataRisk = failureType === 0 ? 0 : replicas < 2 ? capacityLoss : 0;
  const blastRadius =
    failureType === 0 ? 0 : failureType === 3 ? 100 : clamp(Math.max(dataRisk, sharedDependency), 0, 100);
  return {
    azCount,
    replicas,
    sharedDependency,
    failureType,
    rackSpread,
    capacityLoss,
    dataRisk,
    blastRadius,
    availability: 100 - blastRadius,
    correlation:
      failureType === 0
        ? 0
        : clamp(sharedDependency + (replicas < 2 ? 40 : 0) + (failureType === 3 ? 40 : 0), 0, 100),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const blastHealth = healthFor(values.blastRadius, 1, 50);
  const zoneHealth: "ok" | "warn" | "crit" | "down" =
    values.failureType === 3 ? "crit" : values.failureType === 1 ? "down" : values.failureType === 2 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: blastHealth,
        throughput: 100 - values.blastRadius,
        sublabel: `${values.availability.toFixed(1)}% availability`,
        meta: { view: "topology" },
      },
      ...Array.from({ length: values.azCount }, (_, index) => ({
        id: `az-${index}`,
        label: `AZ ${index + 1}`,
        kind: "service" as const,
        health: index === 0 ? zoneHealth : values.failureType === 3 ? "crit" : "ok",
        utilization: clamp(1 / values.azCount),
        sublabel: index === 0 && values.failureType !== 0 ? failureName(values.failureType) : "serving",
        detail: `One of ${values.azCount} zones; ${values.rackSpread} rack${values.rackSpread === 1 ? "" : "s"} per zone. Local failure removes ${values.capacityLoss.toFixed(1)}% of raw capacity.`,
        meta: { view: "topology" },
      })),
      {
        id: "dependency",
        label: "Pinned dependency",
        kind: "external",
        health:
          values.failureType === 0
            ? "ok"
            : values.sharedDependency >= 50
              ? "crit"
              : values.sharedDependency > 0
                ? "warn"
                : "ok",
        throughput: values.sharedDependency,
        sublabel: `${Math.round(values.sharedDependency)}% of requests`,
        detail: "Located in one zone. Every zone that calls it shares the same failure domain.",
        meta: { view: "topology" },
      },
    ],
    edges: [
      ...Array.from({ length: values.azCount }, (_, index) =>
        edge(`lb-az-${index}`, "lb", `az-${index}`, 1 / values.azCount, index === 0 ? zoneHealth : "ok"),
      ),
      edge("az-dependency", "az-0", "dependency", clamp(values.sharedDependency / 100), values.sharedDependency > 0 ? "warn" : "ok"),
    ],
    metrics: [
      metric("blast-radius", "Blast radius", values.blastRadius, "%", 1, 50, "percent"),
      metric("availability", "Availability", values.availability, "%", undefined, undefined, "percent"),
      metric("correlation", "Correlation score", values.correlation, "%", 10, 60, "percent"),
      metric("capacity-loss", "Raw capacity lost", values.capacityLoss, "%", undefined, undefined, "percent"),
      metric("replicas", "Data replicas", values.replicas, " copies", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, failureType: values.failureType, azCount: values.azCount },
    summary: `${failureName(values.failureType)}: ${values.blastRadius.toFixed(1)}% blast radius; ${values.availability.toFixed(1)}% availability; correlation ${values.correlation.toFixed(0)}.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 4)) / 2.8);
  const seeds: [string, number, number][] = [
    ["blast-radius", values.blastRadius, 0.2],
    ["availability", values.availability, 0.1],
    ["correlation", values.correlation, 0.2],
    ["capacity-loss", values.capacityLoss, 0.1],
    ["replicas", values.replicas, 0],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blast-radius",
    metricId: "blast-radius",
    warn: 1,
    crit: 50,
    title: "A single failure reaches most of the product",
    cause:
      "The failed scope is larger than the redundancy boundary, or the redundancy is correlated. A rack, zone, or deployment is only a failure domain if power, network, data copies, and every dependency are independent inside it.",
    fix:
      "Draw the dependency graph for the failed scope. Move or replicate any shared component that lives inside it, spread data copies across independent domains, and make deployments incremental so one bad release cannot reach the fleet.",
    checkFirst: [
      "List every dependency reachable from the failed zone or rack.",
      "Check whether data copies cross the same boundary.",
      "Check whether the deploy or configuration change was fleet-wide.",
    ],
  },
  {
    id: "correlation",
    metricId: "correlation",
    warn: 10,
    crit: 60,
    title: "The redundant domains share a failure source",
    cause:
      "Multiple zones can still depend on one cache, queue, identity service, control plane, or deployment pipeline. The zones are independent for some failures and correlated for others. Replication does not help when the failure is in the shared path.",
    fix:
      "Treat every dependency as a potential single domain. Add a local fallback, replicate the dependency, or accept and document the correlated blast radius. Test the failure that crosses the boundary, not only the one the design expects.",
    checkFirst: [
      "Find the dependency that is called by every zone.",
      "Check where that dependency runs and how it is deployed.",
      "Check whether the last incident's failing component was shared across zones.",
    ],
  },
];

export const failureDomainsModel: SimModel = {
  id: "foundations-failure-domains",
  visual: "topology",
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
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${failureName(values.failureType)}: ${values.blastRadius.toFixed(1)}% blast radius; ${values.availability.toFixed(1)}% availability; correlation ${values.correlation.toFixed(0)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${failureName(values.failureType)}: ${values.capacityLoss.toFixed(1)}% of raw capacity is inside the failed scope, while ${values.blastRadius.toFixed(1)}% of requests fail. The gap between those numbers is the correlation.`,
    );
    if (values.replicas < 2 && values.failureType !== 0) {
      items.push(
        `With ${values.replicas} data replica, a failure in the copy's zone removes the data as well as the capacity. Replication factor 2 or higher is what lets a surviving zone serve the request.`,
      );
    }
    if (values.sharedDependency > 0 && values.failureType !== 0) {
      items.push(
        `${Math.round(values.sharedDependency)}% of requests depend on a component pinned to one zone. That dependency is inside the failed scope even when the application instances are not.`,
      );
    }
    if (values.failureType === 3) {
      items.push(
        "A fleet-wide deploy is a failure domain of its own. It does not need a zone to fail; it reaches every instance because the deployment path is shared.",
      );
    }
    items.push(
      `Capacity loss and blast radius are different questions. Capacity tells you what is left; blast radius tells you what users lose. A design can have plenty of capacity and still fail every request through one shared dependency.`,
    );
    return items;
  },
  legend: [
    { label: "Serving", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three zones, three data copies, no pinned dependency, no failure.",
    tone: "ok",
    params: defaults({ replicas: 3, sharedDependency: 0, failureType: 0, rackSpread: 1 }),
  },
  {
    id: "peak",
    label: "Rack degraded",
    description: "A rack fails in one zone. The app survives, but 10% of requests depend on a pinned component there.",
    tone: "warn",
    params: defaults({ replicas: 3, sharedDependency: 10, failureType: 2, rackSpread: 1 }),
  },
  {
    id: "failure",
    label: "Correlated rack",
    description: "Three zones and three replicas, but a shared dependency lives in the failed rack. The whole service fails.",
    tone: "crit",
    params: defaults({ replicas: 3, sharedDependency: 100, failureType: 2, rackSpread: 1 }),
  },
  {
    id: "deploy",
    label: "Fleet-wide deploy",
    description: "A bad release reaches every instance at once. Zones do not matter because the deployment path is shared.",
    tone: "crit",
    params: defaults({ replicas: 3, sharedDependency: 0, failureType: 3, rackSpread: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The rack still fails, but instances are spread over four racks and no dependency is pinned. Blast radius is zero.",
    tone: "ok",
    params: defaults({ replicas: 3, sharedDependency: 0, failureType: 2, rackSpread: 4 }),
  },
];

const experiment: Experiment = {
  id: "predict-correlation",
  title: "Predict what a rack failure can reach",
  simId: "failure-domains",
  question:
    "The service runs in three zones with three data replicas. A single rack failure takes down every request. What is the most likely cause?",
  prediction: {
    options: [
      { id: "replicas", label: "All three replicas are in the failed rack" },
      { id: "dependency", label: "A shared dependency is pinned to the failed rack" },
      { id: "az", label: "Three zones are not enough for redundancy" },
      { id: "lb", label: "The load balancer has only one instance" },
    ],
    correctOptionId: "dependency",
    explanation:
      "Three replicas can still be correlated if they share a dependency that lives in the failed rack. The application instances are spread, so capacity loss is small, but every request needs the pinned component. A rack is a failure domain only for the components that are actually isolated inside it.",
  },
  setup: defaults({ replicas: 3, sharedDependency: 100, failureType: 2, rackSpread: 1 }),
  runFor: 20,
  observe: [
    "Raw capacity loss is 33.3%: one rack in one of three zones.",
    "Blast radius is 100% because every request depends on the pinned component.",
    "The correlation score is 100: the dependency, not the zone count, sets the blast radius.",
    "Spreading instances over four racks without unpinning the dependency does not reduce the blast radius.",
  ],
  explain:
    "A failure domain is a boundary inside which a failure is contained. Three zones provide three power and network boundaries for the instances, but not for a dependency that lives in one rack. The dependency's boundary is the rack, and every zone calls it. The redundancy claim was true for compute and false for the request path. Only the dependency graph shows the difference.",
  fix: defaults({ replicas: 3, sharedDependency: 0, failureType: 2, rackSpread: 4 }),
  debrief:
    "Removing the pinned dependency and spreading instances over more racks reduces the blast radius to zero for this failure. The rack still fails and raw capacity still drops, but no request needs a component inside it. That is the difference between high availability and spare capacity: availability comes from independent paths, not from the number of zones on a diagram.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A failure domain is a boundary inside which a failure is contained. A rack, an availability zone, a region, a deployment pipeline, and a shared database are all potential failure domains. The label matters less than the independence: separate power, separate network, separate data copies, separate deployment, and separate dependencies. Two zones with one shared cache are not two independent domains for a cache failure.",
  },
  {
    type: "p",
    text: "Blast radius is the share of users or requests affected by one failure. It is not the same as capacity loss. A rack failure that removes one third of the instances may remove zero requests if the remaining instances can absorb the traffic. A rack failure that removes a dependency used by every request can remove all traffic even though most instances are still running.",
  },
  {
    type: "p",
    text: "Correlation is the hidden variable. Redundancy assumes failures are independent. When the same dependency, credential, control plane, or deploy reaches every copy, the copies fail together. The design looks redundant on a topology diagram and behaves as a single domain during the incident.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Failure domains sit around every component in the request path: the load balancer, the application instances, the data store, the cache, the queue, the identity provider, and the deployment system. Each one needs a boundary and a test. The application can be spread across zones while its session store, feature flag service, or DNS provider remains a single domain.",
  },
  {
    type: "table",
    headers: ["Scope", "What it can take down", "What must be independent", "Common mistake"],
    rows: [
      ["Rack", "Instances and dependencies in that rack", "Power, network, placement", "All replicas or a shared cache in one rack"],
      ["Availability zone", "Everything in the zone", "Power, network, data copies", "A dependency called by every zone"],
      ["Region", "Everything in the region", "Data replication, DNS, failover", "A global control plane in one region"],
      ["Deployment", "Every instance running the release", "Rollout batches, rollback", "One pipeline and one release for the fleet"],
    ],
  },
  {
    type: "p",
    text: "This module models three zones, one to three data replicas, and a dependency pinned to one zone. The percentages are illustrative. The shape is the lesson: raw capacity and user impact diverge when a shared dependency sits inside the failed boundary.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Blast radius: the share of requests that fail in the selected failure scope.",
      "Availability: the complement of blast radius, useful for the product conversation.",
      "Correlation score: how much of the failure path is shared across domains.",
      "Raw capacity lost: what the infrastructure loses, which can be much smaller than the user impact.",
      "Zone and dependency node states: which boundary actually failed.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Correlated rack. Compare raw capacity lost with blast radius; the gap is the lesson. Run the experiment before revealing the explanation, then apply Fleet-wide deploy and Recovery. Change the dependency and rack spread separately to see which one moves the blast radius.",
  },
  {
    type: "p",
    text: "The first question is not how many zones the service has. It is which components are inside the failed boundary and which request paths need them. The second question is whether one deploy, one credential, or one control plane can reach every zone at once. If it can, the zones are a diagram, not a failure domain.",
  },
  { type: "sim", simId: "failure-domains" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The rack failure removed one rack in one of three zones. Raw capacity fell by about a third, which a well-spread service might absorb. But every request needed a dependency in that rack, so the blast radius was 100%. The application instances were in three zones; the request path was in one.",
  },
  {
    type: "p",
    text: "Spreading instances over more racks reduced the capacity loss but did not change the blast radius while the dependency stayed pinned. Removing the pin moved the blast radius to zero for the same failure. The fleet-wide deploy preset showed a different correlation: no zone failed, but the deployment path reached every instance, so the release itself was the failure domain.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Infrastructure: per-zone instance counts, load balancer target health, and cross-zone traffic.",
      "Dependencies: per-zone error rates and latency for every service the request path calls.",
      "Data: replica placement, failover events, and whether reads can be served from a surviving zone.",
      "Deployment: batch size, rollout progress, error rate by batch, and rollback time.",
      "Business: error rate and successful requests by zone, which shows whether the impact matches the capacity loss.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the failed scope with the dependency graph. List every component the request path needs and where it runs. Check whether data replicas cross the boundary. Check whether the deploy or configuration change was fleet-wide. If blast radius is larger than capacity loss, a shared dependency is the first hypothesis.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Draw the request path and mark the failure domain of every component.",
      "Move or replicate any dependency that is called by every zone.",
      "Spread data replicas across independent domains and verify failover.",
      "Deploy in batches so one bad release cannot reach the fleet at once.",
      "Test the failure that crosses the boundary, not only the single-component failure.",
      "Accept and document the correlations you cannot remove; every design has some.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cross-zone replication reduces blast radius and adds latency, cost, and consistency work.",
      "A local fallback for a shared dependency can keep serving during a failure, but it may serve stale or degraded data.",
      "Smaller deploy batches reduce blast radius and slow the rollout; larger batches are faster and riskier.",
      "More zones increase independence and multiply the operational surface and cross-zone traffic cost.",
      "Some correlations are unavoidable, such as a single cloud region or a single identity provider. The honest move is to document the blast radius and rehearse the response, not to claim redundancy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rack-failure",
    question:
      "The service runs in three AZs with three replicas, but a single rack failure took down every request. How do you investigate?",
    difficulty: 3,
    hints: [
      "Capacity loss and request failure are different numbers.",
      "Look for a dependency called by every zone.",
    ],
    answer:
      "I would compare the failed scope with the request path. First, confirm the rack and which instances and dependencies ran in it. Then trace a failing request: if it reaches a component in the failed rack from every zone, the zones are not independent for that path. I would check the cache, queue, identity service, DNS, and control plane, not only the application instances. I would also check whether the deploy or configuration change was fleet-wide. The fix is to move or replicate the shared component, or to add a fallback, and then test the same rack failure again.",
    followUps: [
      "How would you prove the dependency is shared?",
      "What if the dependency is a managed service with its own zones?",
      "How do you test this without taking down production?",
    ],
    redFlags: [
      "Adds more AZs without finding the shared path.",
      "Assumes three replicas guarantee availability.",
      "Blames the load balancer without tracing the request.",
    ],
    rubric: [
      "Separates capacity from request impact.",
      "Traces the dependency path.",
      "Checks deploy and control-plane correlation.",
      "Proposes a test that crosses the boundary.",
    ],
  },
  {
    id: "blast-radius-design",
    question:
      "How do you decide whether a service needs multi-AZ, multi-region, or neither?",
    difficulty: 3,
    hints: [
      "Start with the availability target and the cost of downtime.",
      "A failure domain is only useful if the request path is independent inside it.",
    ],
    answer:
      "I would start from the availability target and the business cost of an outage, then map the failure domains that can meet it. Multi-AZ is usually the first step for a single-region service because it protects against a zone failure without cross-region latency. Multi-region is justified when a regional failure is in scope or when latency requires it, and it brings data replication, failover, and consistency costs. Neither is worth anything if the request path still has a shared dependency. I would test the failure, measure the blast radius, and compare the cost of the remaining correlation with the cost of removing it.",
    followUps: [
      "What is the minimum viable multi-region design?",
      "How do you handle data consistency across regions?",
      "When would you accept a single-region design?",
    ],
    redFlags: [
      "Chooses multi-region because it sounds reliable.",
      "Ignores the dependency graph.",
      "Has no availability target.",
    ],
    rubric: [
      "Starts from the availability target.",
      "Maps failure domains to the request path.",
      "Names the cost of each option.",
      "Tests the claimed boundary.",
    ],
  },
  {
    id: "test-domain",
    question:
      "How do you test that a failure domain is actually independent before an incident proves it?",
    difficulty: 3,
    hints: [
      "Test the dependency path, not only the instances.",
      "A game day needs a guardrail and a rollback.",
    ],
    answer:
      "I would start with the dependency graph and identify every component the request path needs in the domain. Then I would run a bounded failure injection: remove a zone or rack in a staging environment, blackhole the shared dependency, or deploy a bad batch to a canary group, and measure the blast radius against the prediction. In production I would use a small blast-radius experiment with an automatic abort and a rollback. The test should cross the boundary the design claims is independent, not just stop one instance. If the measured blast radius is larger than the capacity loss, the dependency graph is incomplete.",
    followUps: [
      "What guardrails would you put on a production game day?",
      "How do you test a shared control plane?",
      "What would make you abort the experiment?",
    ],
    redFlags: [
      "Tests only a single instance.",
      "Runs an unbounded production failure.",
      "Has no predicted blast radius.",
    ],
    rubric: [
      "Uses the dependency graph.",
      "Tests the shared path.",
      "Bounds the experiment.",
      "Compares measured and predicted impact.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every component in the request path has a documented failure domain.",
      "Data replicas are placed across independent domains and failover is tested.",
      "Shared dependencies are listed with the zones that call them.",
      "Deployments are batched and rollback is rehearsed.",
      "A failure test crosses a domain boundary, not only a single instance.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare raw capacity loss with request failure rate.",
      "Trace a failing request to the first component inside the failed scope.",
      "Check whether every zone calls the same dependency.",
      "Check whether a deployment or configuration change reached the fleet.",
      "Record the blast radius and the correlation hypothesis.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove or replicate the shared dependency that defeated the boundary.",
      "Re-test the same failure and compare blast radius.",
      "Review whether the deployment path is a single domain.",
      "Document the correlations that remain and their accepted risk.",
    ],
  },
];

const references = [
  {
    title: "Reliability pillar: failure management",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Failure domains, static stability, and blast radius.",
  },
  {
    title: "Site Reliability Engineering",
    url: "https://sre.google/sre-book/table-of-contents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Redundancy, failure domains, and the limits of replication.",
  },
  {
    title: "Static stability using Availability Zones",
    url: "https://aws.amazon.com/builders-library/static-stability-using-availability-zones/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Designing for a zone failure without depending on control-plane reaction.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "failure-domains": {
      model: failureDomainsModel,
      presets,
      instructions:
        "Start healthy, then apply Correlated rack. Compare raw capacity lost with blast radius. Run the experiment, then apply Fleet-wide deploy and Recovery. Change the pinned dependency and the rack spread separately.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Zone counts and impact percentages are teaching values, not a cloud provider guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-capacity-headroom",
    "reliability-multi-az",
    "reliability-blast-radius",
    "deployment-canary",
  ],
};
