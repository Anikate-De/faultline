import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "storageCoverage",
    label: "Data stores pinned to the region",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data plane",
    help: "Share of primary stores, replicas, object buckets, and backups configured in the required region. A regional bucket does not cover a global metadata table or a cross-region replica.",
    format: "percent" as const,
  },
  {
    id: "processingCoverage",
    label: "Processing that runs in the region",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data plane",
    help: "Share of compute that reads or transforms customer data inside the region, including batch jobs, queues, and scheduled exports. A regional store read by a job elsewhere is not residency.",
    format: "percent" as const,
  },
  {
    id: "telemetryCoverage",
    label: "Telemetry kept in the region",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Observability",
    help: "Share of logs, metrics, traces, and error reports retained in the region. A global exporter can copy request payloads and identifiers out of the region even when the database stays local.",
    format: "percent" as const,
  },
  {
    id: "supportAccessCoverage",
    label: "Support access confined to the region",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Operations",
    help: "Share of administrative and vendor support sessions that read or export data only through in-region access. A global support console with a screen-share or database export is a cross-border path.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  storage: number;
  processing: number;
  telemetry: number;
  support: number;
  coverage: number;
  violations: number;
  storageGap: number;
  processingGap: number;
  telemetryGap: number;
  supportGap: number;
}

function compute(p: Params): Computed {
  const storage = clamp(num(p, "storageCoverage", 100), 0, 100);
  const processing = clamp(num(p, "processingCoverage", 100), 0, 100);
  const telemetry = clamp(num(p, "telemetryCoverage", 100), 0, 100);
  const support = clamp(num(p, "supportAccessCoverage", 100), 0, 100);
  const coverage = Math.min(storage, processing, telemetry, support);
  return {
    storage,
    processing,
    telemetry,
    support,
    coverage,
    violations: 100 - coverage,
    storageGap: 100 - storage,
    processingGap: 100 - processing,
    telemetryGap: 100 - telemetry,
    supportGap: 100 - support,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const processingHealth = healthFor(values.processingGap, 10, 30);
  const storageHealth = healthFor(values.storageGap, 10, 30);
  const telemetryHealth = healthFor(values.telemetryGap, 1, 20);
  const supportHealth = healthFor(values.supportGap, 1, 20);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Customer request",
        kind: "client",
        health: "ok",
        utilization: 0.5,
        sublabel: "enters through the nearest edge",
        detail: "The request may be terminated at a global edge. The edge is acceptable only if the path that reads or stores customer data continues into the required region.",
      },
      {
        id: "edge",
        label: "Global edge",
        kind: "cdn",
        health: processingHealth,
        utilization: values.processingGap / 100,
        sublabel: `${values.processing.toFixed(0)}% routed to regional compute`,
        detail: "A global edge can terminate TLS and route without retaining the payload. It becomes a residency path when it logs request bodies or calls an origin outside the region.",
      },
      {
        id: "app",
        label: "Regional application",
        kind: "service",
        health: processingHealth,
        utilization: values.processingGap / 100,
        sublabel: `${values.processing.toFixed(0)}% of processing in-region`,
        detail: "The compute that reads and transforms customer data. Batch jobs, queues, and scheduled exports count as processing, not as storage.",
      },
      {
        id: "store",
        label: "Regional primary store",
        kind: "db",
        health: storageHealth,
        utilization: values.storageGap / 100,
        sublabel: `${values.storage.toFixed(0)}% pinned in-region`,
        detail: "The primary database or object store. It is the part most teams configure correctly and the part a contract usually names first.",
      },
      {
        id: "backup",
        label: "Backups and replicas",
        kind: "storage",
        health: storageHealth,
        utilization: values.storageGap / 100,
        sublabel: `${values.storage.toFixed(0)}% covered by the region policy`,
        detail: "Backups and cross-region replicas are copies of the data. A disaster-recovery replica in another region is still a residency path unless the contract permits it.",
      },
      {
        id: "telemetry",
        label: "Telemetry pipeline",
        kind: "storage",
        health: telemetryHealth,
        utilization: values.telemetryGap / 100,
        sublabel: `${values.telemetry.toFixed(0)}% retained in-region`,
        detail: "Logs, metrics, traces, and error reports can carry identifiers and full request bodies. A global observability vendor is a processing destination, not a neutral pipe.",
      },
      {
        id: "support",
        label: "Support access",
        kind: "external",
        health: supportHealth,
        utilization: values.supportGap / 100,
        sublabel: `${values.support.toFixed(0)}% confined to the region`,
        detail: "Administrative sessions, vendor support, and on-call access can read or export data. The path matters even when no application code changed.",
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", 1),
      edge("edge-app", "edge", "app", clamp(values.processing / 100), processingHealth),
      edge("app-store", "app", "store", clamp(values.storage / 100), storageHealth),
      edge("store-backup", "store", "backup", clamp(values.storage / 100), storageHealth),
      edge("app-telemetry", "app", "telemetry", clamp(values.telemetry / 100), telemetryHealth),
      edge("support-store", "support", "store", clamp(values.support / 100), supportHealth),
    ],
    metrics: [
      metric("boundary-violations", "Residency boundary violations", values.violations, "%", 1, 25, "percent"),
      metric("telemetry-gap", "Telemetry retained outside the region", values.telemetryGap, "%", 1, 20, "percent"),
      metric("support-gap", "Support access outside the region", values.supportGap, "%", 1, 20, "percent"),
      metric("in-region-coverage", "In-region coverage floor", values.coverage, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `In-region coverage is ${values.coverage.toFixed(0)}%; boundary violations are ${values.violations.toFixed(0)}%; telemetry is ${values.telemetryGap.toFixed(0)} points outside and support access is ${values.supportGap.toFixed(0)} points outside.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "boundary-violations",
    metricId: "boundary-violations",
    warn: 1,
    crit: 25,
    title: "A data path crosses the residency boundary",
    cause:
      "The commitment is only as strong as its least-local layer. A regional database read by a job in another region, a backup replica, a global telemetry exporter, or a vendor support session can move data outside the boundary. A single uncovered path is a breach of the commitment even when storage is correctly pinned.",
    fix:
      "Enumerate every path that reads, stores, processes, or exports the data, including batch, analytics, backups, telemetry, and support. Pin each one to the region or replace it. Enforce the boundary with policy and network controls, then test the path with a synthetic record and review the destination logs.",
    checkFirst: [
      "Which layer is outside: storage, processing, backup, telemetry, or support?",
      "Does the contract define the boundary by geography, legal entity, or both?",
      "Which global services or vendors can see the data, including metadata?",
    ],
  },
  {
    id: "telemetry-gap",
    metricId: "telemetry-gap",
    warn: 1,
    crit: 20,
    title: "Telemetry is leaving the region",
    cause:
      "Observability is often added as a global sidecar or agent. Logs and traces can contain request bodies, identifiers, and error context. A regional application can therefore keep its database local while shipping a copy of the data to a vendor or a central account in another region.",
    fix:
      "Run a regional telemetry pipeline and keep the storage and processing in the same boundary. Remove sensitive fields before export, disable global forwarding, and verify the vendor's retention and support paths. Treat the observability destination as a processor, not as a passive sink.",
    checkFirst: [
      "Which agents, sidecars, and SDKs export outside the region?",
      "Do the events contain identifiers or full payloads?",
      "Where does the observability vendor store and support the data?",
    ],
  },
  {
    id: "support-gap",
    metricId: "support-gap",
    warn: 1,
    crit: 20,
    title: "Support access reaches data outside the region",
    cause:
      "A support console, screen share, or vendor admin session may read production data from another country. The application path can be fully regional while a human or a support tool moves the data. Access is a processing path when the session can view or export records.",
    fix:
      "Route support sessions through in-region access, require just-in-time approval, disable bulk export and clipboard transfer, and record the session. Confirm where the vendor's support staff and subcontractors are located, and include support in the residency evidence rather than only in the security review.",
    checkFirst: [
      "Which support tools can read production data directly?",
      "Where are the people and subprocessors who use them located?",
      "Can a session export data or copy it to a local device?",
    ],
  },
];

export const residencyModel: SimModel = {
  id: "compliance-data-residency",
  visual: "topology",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.violations >= 25 && frame.flags.boundaryEvent !== 1) {
      const weakest = [
        { id: "store", label: "storage", gap: values.storageGap },
        { id: "app", label: "processing", gap: values.processingGap },
        { id: "telemetry", label: "telemetry", gap: values.telemetryGap },
        { id: "support", label: "support access", gap: values.supportGap },
      ].sort((a, b) => b.gap - a.gap)[0];
      pushEvent(next, {
        id: "path-left-region",
        at: frame.t,
        severity: "crit",
        title: "A data path crosses the residency boundary",
        detail: `In-region coverage is ${values.coverage.toFixed(0)}%. The weakest layer is ${weakest.label} at ${weakest.gap.toFixed(0)} points outside; telemetry is ${values.telemetryGap.toFixed(0)} points outside and support access is ${values.supportGap.toFixed(0)} points outside. A regional store does not make the full path local.`,
        nodeId: weakest.id,
        metricId: "boundary-violations",
      });
      next.flags.boundaryEvent = 1;
    }
    if (values.violations < 25) next.flags.boundaryEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `In-region coverage is ${values.coverage.toFixed(0)}%; boundary violations are ${values.violations.toFixed(0)}%; telemetry is ${values.telemetryGap.toFixed(0)} points outside and support access is ${values.supportGap.toFixed(0)} points outside.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const weakest =
      values.coverage === values.storage
        ? "storage"
        : values.coverage === values.processing
          ? "processing"
          : values.coverage === values.telemetry
            ? "telemetry"
            : "support access";
    return [
      `In-region coverage is ${values.coverage.toFixed(0)}%, set by ${weakest}. Residency is a floor across storage, processing, telemetry, and support, not a property of one bucket.`,
      `Storage is ${values.storage.toFixed(0)}% and processing is ${values.processing.toFixed(0)}%. A regional store read by compute elsewhere is a processing path outside the boundary.`,
      `Telemetry is ${values.telemetryGap.toFixed(0)} points outside and support access is ${values.supportGap.toFixed(0)} points outside. Both can carry customer data without a database change.`,
      "A region is a geographic area with isolated availability zones; an availability zone is a failure domain inside a region. Neither term alone defines the contractual boundary, which may name a country, a legal entity, or an approved list.",
      "The percentages and thresholds are illustrative teaching values, not a contract or legal interpretation.",
    ];
  },
  legend: [
    { label: "In region", tone: "ok" },
    { label: "Review", tone: "warn" },
    { label: "Crosses boundary", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Storage, processing, telemetry, backups, and support access all stay inside the required region.",
    tone: "ok",
    params: defaults({ storageCoverage: 100, processingCoverage: 100, telemetryCoverage: 100, supportAccessCoverage: 100 }),
  },
  {
    id: "peak",
    label: "Regional pressure",
    description: "A batch job and a support path are partly outside the region while storage remains local.",
    tone: "warn",
    params: defaults({ storageCoverage: 100, processingCoverage: 90, telemetryCoverage: 95, supportAccessCoverage: 90 }),
  },
  {
    id: "failure",
    label: "Global by default",
    description: "Storage is regional, but processing, telemetry, and support are global. The bucket is local and the path is not.",
    tone: "crit",
    params: defaults({ storageCoverage: 100, processingCoverage: 70, telemetryCoverage: 0, supportAccessCoverage: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The batch job, telemetry pipeline, and support access are pinned to the region, and the boundary is enforced.",
    tone: "ok",
    params: defaults({ storageCoverage: 100, processingCoverage: 100, telemetryCoverage: 100, supportAccessCoverage: 100 }),
  },
  {
    id: "store-only",
    label: "Store-only residency",
    description: "The database is correctly regional, but the telemetry destination and vendor support path are not fully covered.",
    tone: "warn",
    params: defaults({ storageCoverage: 100, processingCoverage: 100, telemetryCoverage: 90, supportAccessCoverage: 85 }),
  },
];

const experiment: Experiment = {
  id: "predict-bucket",
  title: "Predict whether a regional bucket is enough",
  simId: "residency",
  question:
    "Customer records are stored in an EU bucket and the application runs in an EU region. A global observability vendor receives request logs, and vendor support opens sessions from outside the EU. Is the service EU-only?",
  prediction: {
    options: [
      { id: "yes-storage", label: "Yes. The records and the application are in the EU" },
      { id: "no-paths", label: "No. Telemetry and support access are processing paths outside the region" },
      { id: "yes-encryption", label: "Yes, because the logs are encrypted in transit" },
      { id: "no-backup", label: "No, but only because backups are not in the bucket" },
    ],
    correctOptionId: "no-paths",
    explanation:
      "Storage location is one layer. Logs and support sessions can read or export the same data from outside the region, so the full path is not EU-only. Encryption protects the transfer but does not change where the data is processed or who can access it. The commitment has to be traced through every layer that can see the data.",
  },
  setup: defaults({ storageCoverage: 100, processingCoverage: 90, telemetryCoverage: 0, supportAccessCoverage: 20 }),
  runFor: 20,
  observe: [
    "The regional store is healthy, but in-region coverage is 0% because telemetry has no local path.",
    "Boundary violations reach 100%, and the telemetry and support nodes fail.",
    "The application node is only partly degraded even though the full path is outside the boundary.",
    "Adding encryption or a second regional bucket would not close the telemetry or support gaps.",
  ],
  explain:
    "Residency is a property of the whole processing path. Logs are copies, and support access is a read path. A global observability agent can ship identifiers with every request, and a vendor support session can query production directly. The engineering fix is to enumerate all paths, pin each one, and enforce the destination. The contract may also define permitted support locations and subprocessors, which is a legal review rather than an architecture choice.",
  fix: defaults({ storageCoverage: 100, processingCoverage: 100, telemetryCoverage: 100, supportAccessCoverage: 100 }),
  debrief:
    "With telemetry and support access pinned to the region, the same application and bucket now sit inside a complete path. The lesson is to stop treating the database as the boundary. This module is engineering education, not legal advice; a real residency commitment depends on the contract, the applicable law, and the facts, and may permit or prohibit paths the model does not cover.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Data residency is the practice of keeping data inside a defined geographic or legal boundary. A customer contract may require storage in the European Union, a regulator may require processing in a country, or an internal policy may restrict where a dataset can go. The boundary is a property of the whole path: where data is stored, where it is processed, where backups and replicas live, where telemetry is sent, and who can access it for support.",
  },
  {
    type: "p",
    text: "A cloud region is a geographic area with multiple isolated availability zones. An availability zone is a failure domain inside a region. Neither term defines the contract by itself. The contract might name a country, a legal entity, an approved region list, or a set of subprocessors. Engineering has to translate that language into concrete destinations, then prove that every path respects them.",
  },
  {
    type: "p",
    text: "Residency is also not the same as data sovereignty. Sovereignty concerns who has legal control and whose law applies; residency concerns where the data and processing sit. Encryption, a local bucket, and a regional database are useful controls, but they do not answer the question of where the telemetry vendor stores its copy or where a support engineer opens a session.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path starts at the edge and continues through compute, storage, backups, observability, and operations. A global edge can be acceptable when it only routes and does not retain the payload. A global control plane can be acceptable for configuration metadata, but not for customer records. The risky layers are usually the ones outside the application repository: the observability agent, the batch job in a shared account, the disaster-recovery replica, and the vendor support console.",
  },
  {
    type: "table",
    headers: ["Layer", "A common cross-boundary path", "Engineering control"],
    rows: [
      ["Storage", "Cross-region replica or a global metadata table", "Region-pinned buckets, databases, and key stores"],
      ["Processing", "Batch job, queue consumer, or analytics query in another region", "Regional compute, queue, and scheduler placement"],
      ["Telemetry", "Global log, metric, trace, or error exporter", "Regional pipeline and field redaction before export"],
      ["Support", "Vendor console, screen share, or direct production query", "In-region access, just-in-time approval, session audit"],
      ["Backups", "Disaster-recovery copy in a different jurisdiction", "Region policy, encryption, and documented restore path"],
    ],
  },
  {
    type: "p",
    text: "The model scores the weakest of storage, processing, telemetry, and support access. It also exposes the two layers most often missed: telemetry and support. That is deliberate. A team can pass a storage review and still fail the commitment because an observability vendor or a support session sees the data from outside the boundary.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Boundary violations: the share of the path outside the required region, set by the weakest layer.",
      "Telemetry gap: the share of logs, metrics, and traces retained outside the region.",
      "Support gap: the share of administrative or vendor access that can read or export data from outside.",
      "In-region coverage floor: the best guaranteed coverage across storage, processing, telemetry, and support.",
      "Node states: the global edge, regional application, store, backup, telemetry, and support nodes show where the path leaves.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Regional pressure and find the layer that leaves first. Apply Global by default and note that the regional store stays healthy while telemetry and support fail. Run the experiment before revealing the explanation, then apply Store-only residency to see how a local bucket can coexist with a global path, and Recovery to close it.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. A residency commitment depends on the contract, the applicable law, the entity structure, and the facts. Adequacy decisions and transfer mechanisms are legal tools, not engineering guarantees. Have counsel and your privacy officer confirm the boundary before you rely on it.",
  },
  { type: "sim", simId: "residency" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The regional store stayed healthy while the path failed. Telemetry had no local destination, so request logs crossed the boundary on every call, and support access could read production from outside the region. The application node looked only partly degraded because its own compute placement was mostly correct; the floor was set by the two operational layers that the storage review did not include.",
  },
  {
    type: "p",
    text: "Pinning telemetry and support access to the region cleared the boundary metric without changing the database. That is the lesson: residency is an end-to-end property, and the last mile is often observability or operations rather than the primary data store.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A path inventory that lists storage, compute, queues, backups, telemetry, and support access with a region for each.",
      "Telemetry agents and SDKs that export to a regional endpoint and redact sensitive fields before leaving the process.",
      "Support sessions that require in-region access, just-in-time approval, and recorded audit.",
      "Backup and disaster-recovery policies that state whether a cross-region copy is permitted.",
      "Destination logs and policy checks that show where data actually went, not only where it was configured to go.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Write down the boundary as a concrete list of allowed regions, entities, and subprocessors.",
      "List every path that reads, stores, processes, or exports the data, including batch and manual jobs.",
      "Check the observability pipeline and every SDK that can send request context.",
      "Check vendor support, admin consoles, and on-call access for out-of-region reads.",
      "Verify backups and replicas against the boundary, including disaster recovery.",
      "Test with a synthetic record and inspect the destination logs.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Translate the commitment into allowed destinations and a named owner.",
      "Pin storage, compute, queues, and backups to the region.",
      "Build a regional telemetry path, or remove sensitive fields before export.",
      "Confine support access to the region and record every session.",
      "Enforce the boundary with network and policy controls, not documentation alone.",
      "Test the full path and review destination logs after every new integration.",
      "Re-check the contract when a vendor adds a region, a subprocessor, or a support location.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A single-region design simplifies residency and increases latency and disaster-recovery risk; a second region needs a contract that permits it.",
      "Regional telemetry improves compliance and costs more than a shared global observability account; field redaction can reduce the gap.",
      "In-region support reduces cross-border access and can slow incident response when the local team is asleep.",
      "Customer-managed keys improve control and add rotation and availability work; key location is itself a residency decision.",
      "A strict destination allowlist prevents accidental egress and adds onboarding friction for every new integration.",
      "Global control-plane metadata is easier to operate and may still be acceptable if it contains no customer data; verify the payload rather than the service name.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "boundary-definition",
    question: "How do you turn an EU-only contract clause into an engineering boundary?",
    difficulty: 2,
    hints: [
      "Start with the data and the allowed destinations, not the region name.",
      "The clause may cover support and subprocessors, not only storage.",
    ],
    answer:
      "I would ask what the clause actually restricts: storage location, processing location, support access, subprocessors, or all of them. Then I would translate it into an allowlist of regions, accounts, vendors, and support locations, and map every data path to that list. I would include backups, replicas, telemetry, batch jobs, and administrative access, because those are common gaps. The result is a technical policy with an owner and a test, plus a list of questions for counsel where the contract is ambiguous.",
    followUps: [
      "How do you handle a global control plane that stores only metadata?",
      "What if the customer permits a DR region under conditions?",
      "How do you prove the boundary to an auditor?",
    ],
    redFlags: [
      "Treats the region of the database as the whole answer.",
      "Ignores support and telemetry.",
      "Promises a legal interpretation without review.",
    ],
    rubric: [
      "Clarifies the clause.",
      "Builds a destination allowlist.",
      "Covers all data paths.",
      "Assigns ownership and evidence.",
    ],
  },
  {
    id: "telemetry-leak",
    question: "Why is telemetry a residency risk when the application database is regional?",
    difficulty: 3,
    hints: [
      "Logs and traces can contain request bodies and identifiers.",
      "The exporter is a processing destination.",
    ],
    answer:
      "Telemetry is a copy of the data path, not a neutral observer. An agent or SDK can attach request bodies, user identifiers, headers, and error context to logs and traces, then send them to a global vendor or a central account. The database remains regional while the observability destination processes the same data elsewhere. I would inventory the exporters, redact fields close to the source, use a regional pipeline and storage, and verify the vendor's retention and support locations. I would also test what a real request emits, because the schema may be broader than the team expects.",
    followUps: [
      "Where would you enforce redaction: SDK, collector, or storage?",
      "How do you handle a vendor that aggregates across regions?",
      "What evidence would you keep for the telemetry path?",
    ],
    redFlags: [
      "Assumes logs contain no personal data.",
      "Relies on encryption as a location control.",
      "Reviews only the application repository.",
    ],
    rubric: [
      "Treats telemetry as a data path.",
      "Checks payload content.",
      "Uses regional processing and redaction.",
      "Verifies vendor and evidence.",
    ],
  },
  {
    id: "support-access",
    question: "A vendor support engineer needs production access during an incident. How do you keep that access within the residency boundary?",
    difficulty: 3,
    hints: [
      "Access is a processing path when the session can read or export data.",
      "Approval, location, and session controls are separate decisions.",
    ],
    answer:
      "I would require a just-in-time session through an in-region access path, with an approved ticket, a named approver, and a time limit. The session should be recorded, bulk export and clipboard transfer disabled, and the data minimized to what the incident needs. I would confirm where the support engineer and any subcontractor are located, because a global console can route the session outside the boundary even when the database is local. After the incident I would review the recording and the queries, then close the access. If the contract does not permit that location, the answer may be a local support path or a different escalation.",
    followUps: [
      "How do you handle a break-glass emergency at 03:00?",
      "What if the vendor's support tool is global by design?",
      "How do you verify the session location?",
    ],
    redFlags: [
      "Grants standing production access.",
      "Relies on a policy document without session controls.",
      "Ignores where the support person is located.",
    ],
    rubric: [
      "Uses just-in-time access.",
      "Considers location and subprocessors.",
      "Records and reviews the session.",
      "Minimizes data and export.",
    ],
  },
];

const checklist = [
  {
    title: "Before launch",
    items: [
      "Translate the contract into allowed regions, entities, vendors, and support locations.",
      "Map storage, compute, queues, backups, telemetry, and support access to the boundary.",
      "Choose regional endpoints for every SDK and agent that can send customer data.",
      "Define the disaster-recovery and backup policy, including any permitted cross-region copy.",
    ],
  },
  {
    title: "At the boundary",
    items: [
      "Enforce destination allowlists in network and application policy.",
      "Redact identifiers and payloads before telemetry export.",
      "Require just-in-time, recorded support access from approved locations.",
      "Log the destination and fields for every outbound path.",
    ],
  },
  {
    title: "After a change",
    items: [
      "Re-test the full path when a vendor adds a region or subprocessor.",
      "Review telemetry schemas and new SDK defaults.",
      "Check support tooling and on-call routing after an acquisition or reorg.",
      "Update the path inventory and the evidence used for the commitment.",
    ],
  },
];

const references = [
  {
    title: "Regions and Availability Zones",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.RegionsAndAvailabilityZones.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How AWS defines regions and availability zones, the building blocks behind a cloud residency boundary.",
  },
  {
    title: "Adequacy decisions",
    url: "https://commission.europa.eu/law/law-topic/data-protection/international-dimension-data-protection/adequacy-decisions_en",
    publisher: "European Commission",
    kind: "docs" as const,
    note: "Official background on transfer mechanisms; a legal tool that is separate from engineering residency controls.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    residency: {
      model: residencyModel,
      presets,
      instructions:
        "Start Healthy, then apply Regional pressure and identify the first layer outside the boundary. Apply Global by default and compare the regional store with telemetry and support. Run the experiment before revealing the explanation, then apply Store-only residency and Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 1/25 and 1/20 thresholds are teaching values, not contract terms or legal requirements. The model does not decide whether a transfer mechanism is valid.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-cross-az-region", "compliance-gdpr", "compliance-subprocessors"],
};
