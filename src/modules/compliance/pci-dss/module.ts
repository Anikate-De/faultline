import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "tokenization",
    label: "Payment paths tokenized before storage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Scope reduction",
    help: "Share of payment flows where the primary account number is replaced by a token before it reaches an internal store or downstream system. A token service that still exposes the PAN does not reduce scope.",
    format: "percent" as const,
  },
  {
    id: "segmentation",
    label: "Card-data environment segmented",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Scope reduction",
    help: "Share of the cardholder data environment isolated by enforced network policy, identity boundaries, and default-deny paths. A VLAN drawing without enforcement is not segmentation.",
    format: "percent" as const,
  },
  {
    id: "minimization",
    label: "Stored data minimized",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data handling",
    help: "Share of systems that avoid storing cardholder data unless a documented business need requires it. Copies created for analytics, support, or debugging keep the data in scope.",
    format: "percent" as const,
  },
  {
    id: "discovery",
    label: "Card-data flows discovered",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data handling",
    help: "Share of systems and data flows that have been inventoried as touching cardholder data. An unknown path cannot be segmented, tokenized, or assessed.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tokenization: number;
  segmentation: number;
  minimization: number;
  discovery: number;
  reach: number;
  uncontrolled: number;
  scopeGap: number;
  tokenGap: number;
  segmentationGap: number;
  minimizationGap: number;
  discoveryGap: number;
  scopeSystems: number;
}

function compute(p: Params): Computed {
  const tokenization = clamp(num(p, "tokenization", 100), 0, 100);
  const segmentation = clamp(num(p, "segmentation", 100), 0, 100);
  const minimization = clamp(num(p, "minimization", 100), 0, 100);
  const discovery = clamp(num(p, "discovery", 100), 0, 100);
  const reach = Math.min(tokenization, segmentation, minimization);
  const scopeGap = 100 - Math.min(tokenization, segmentation, minimization, discovery);
  return {
    tokenization,
    segmentation,
    minimization,
    discovery,
    reach,
    uncontrolled: 100 - reach,
    scopeGap,
    tokenGap: 100 - tokenization,
    segmentationGap: 100 - segmentation,
    minimizationGap: 100 - minimization,
    discoveryGap: 100 - discovery,
    scopeSystems: Math.round(
      8 +
        (100 - tokenization) * 0.35 +
        (100 - segmentation) * 0.25 +
        (100 - minimization) * 0.2 +
        (100 - discovery) * 0.2,
    ),
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
  const cdeHealth = healthFor(Math.max(values.segmentationGap, values.minimizationGap), 20, 45);
  return {
    t: 0,
    nodes: [
      {
        id: "storefront",
        label: "Storefront",
        kind: "client",
        health: "ok",
        utilization: 0.5,
        sublabel: "customer enters card details",
        detail: "The browser or mobile client is the start of the payment flow. It should post card data directly to the token service or payment processor, not through unrelated services.",
      },
      {
        id: "checkout",
        label: "Checkout API",
        kind: "service",
        health: healthFor(values.tokenGap, 15, 40),
        utilization: values.tokenGap / 100,
        sublabel: `${values.tokenization.toFixed(0)}% tokenized before storage`,
        detail: "The orchestration service. If it receives and forwards a PAN, it is in scope even when it does not store the value.",
      },
      {
        id: "vault",
        label: "Token service",
        kind: "db",
        health: healthFor(values.tokenGap, 15, 40),
        utilization: values.tokenGap / 100,
        sublabel: `${values.tokenGap.toFixed(0)}% of flows bypass tokenization`,
        detail: "A token service replaces the PAN with a surrogate that downstream systems can use. The service and its key material remain in scope, but the systems that only see tokens do not handle card data.",
      },
      {
        id: "cde",
        label: "Card-data environment",
        kind: "db",
        health: cdeHealth,
        utilization: Math.max(values.segmentationGap, values.minimizationGap) / 100,
        sublabel: `${values.segmentation.toFixed(0)}% segmented · ${values.minimization.toFixed(0)}% minimized`,
        detail: "Systems that store, process, or transmit cardholder data. Network policy, identity boundaries, and data minimization define how far this environment extends.",
      },
      {
        id: "warehouse",
        label: "Analytics warehouse",
        kind: "storage",
        health: healthFor(values.tokenGap, 15, 40),
        utilization: values.tokenGap / 100,
        sublabel: `${values.tokenGap.toFixed(0)}% of copies still contain card data`,
        detail: "An analytics copy is a card-data store unless tokenization removed the PAN before the copy. Encryption at rest does not turn it into a non-card-data system.",
      },
      {
        id: "support",
        label: "Support console",
        kind: "service",
        health: healthFor(values.discoveryGap, 15, 40),
        utilization: values.discoveryGap / 100,
        sublabel: `${values.discovery.toFixed(0)}% of flows inventoried`,
        detail: "Vendors, support tools, and exports can reach card data outside the payment path. Unknown access paths expand scope and are invisible to segmentation policy.",
      },
    ],
    edges: [
      edge("storefront-checkout", "storefront", "checkout", 1),
      edge("checkout-vault", "checkout", "vault", clamp(values.tokenization / 100), healthFor(values.tokenGap, 15, 40)),
      edge("checkout-cde", "checkout", "cde", 1, cdeHealth),
      edge("cde-warehouse", "cde", "warehouse", clamp(values.tokenGap / 100), healthFor(values.tokenGap, 15, 40)),
      edge("cde-support", "cde", "support", clamp(values.discoveryGap / 100), healthFor(values.discoveryGap, 15, 40)),
    ],
    metrics: [
      metric("uncontrolled-reach", "Card data reaching uncontrolled systems", values.uncontrolled, "%", 15, 35, "percent"),
      metric("scope-gap", "Scope reduction gap", values.scopeGap, "%", 20, 50, "percent"),
      metric("discovery-gap", "Undiscovered card-data flows", values.discoveryGap, "%", 15, 40, "percent"),
      metric("in-scope-systems", "Illustrative in-scope systems", values.scopeSystems, " systems", undefined, undefined, "count"),
      metric("tokenized-share", "Tokenized payment paths", values.tokenization, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Card data reaches uncontrolled systems on ${values.uncontrolled.toFixed(0)}% of paths; the illustrative scope is ${values.scopeSystems} systems; ${values.discoveryGap.toFixed(0)}% of flows are undiscovered.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "uncontrolled-reach",
    metricId: "uncontrolled-reach",
    warn: 15,
    crit: 35,
    title: "Card data reaches systems outside the intended boundary",
    cause:
      "Scope follows cardholder data and the systems that can reach it. A payment path that passes a PAN to analytics, support, or a logging pipeline puts those systems in scope even if the primary database is segmented. Tokenization that is bypassed, or a token that can be reversed without controls, does not shrink the boundary.",
    fix:
      "Move tokenization to the earliest point where the PAN is no longer needed, make the token service the only system that can detokenize, and remove card data from downstream copies. Enforce the boundary with network policy and identity, then re-inventory every flow that can reach the token service or the card-data environment.",
    checkFirst: [
      "Which systems still receive a PAN instead of a token?",
      "Can a downstream system detokenize, or only store an opaque surrogate?",
      "Which support, analytics, and vendor paths can reach the card-data environment?",
    ],
  },
  {
    id: "scope-gap",
    metricId: "scope-gap",
    warn: 20,
    crit: 50,
    title: "The assessment boundary is larger than the team believes",
    cause:
      "The scope gap is the weakest of tokenization, segmentation, minimization, and discovery. An accurate diagram is not enough: a single undiscovered export or an unenforced route can put an entire platform in scope. Segmentation that is not enforced by default-deny policy is a drawing.",
    fix:
      "Inventory card-data flows from the payment entry point outward, then reduce scope in this order: tokenize before storage, minimize copies, and enforce segmentation around what remains. Validate the boundary with traffic data, not only architecture review, and repeat the inventory after every new integration.",
    checkFirst: [
      "Is the card-data environment defined by an inventory or by an architecture diagram?",
      "Does network policy deny by default, and who can change it?",
      "When was the last end-to-end card-data flow test?",
    ],
  },
];

export const pciDssModel: SimModel = {
  id: "compliance-pci-dss",
  visual: "flow",
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
    if (values.uncontrolled >= 35 && frame.flags.scopeEvent !== 1) {
      pushEvent(next, {
        id: "card-data-outside-boundary",
        at: frame.t,
        severity: "crit",
        title: "Card data reaches systems outside the intended boundary",
        detail: `Card data reaches uncontrolled systems on ${values.uncontrolled.toFixed(0)}% of modeled paths. The illustrative scope is ${values.scopeSystems} systems. An assessor can sample a downstream copy and find cardholder data outside the documented environment.`,
        nodeId: "warehouse",
        metricId: "uncontrolled-reach",
      });
      next.flags.scopeEvent = 1;
    }
    if (values.uncontrolled < 35) next.flags.scopeEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Card data reaches uncontrolled systems on ${values.uncontrolled.toFixed(0)}% of paths; the illustrative scope is ${values.scopeSystems} systems; ${values.discoveryGap.toFixed(0)}% of flows are undiscovered.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const reducers = [
      { label: "tokenization", value: values.tokenization },
      { label: "segmentation", value: values.segmentation },
      { label: "data minimization", value: values.minimization },
      { label: "flow discovery", value: values.discovery },
    ].sort((a, b) => a.value - b.value);
    return [
      `The weakest scope reducer is ${reducers[0].label} at ${reducers[0].value.toFixed(0)}%. Scope reduction is limited by the path that still handles the PAN, not by the strongest control elsewhere.`,
      `Tokenization covers ${values.tokenization.toFixed(0)}% of payment paths. A token replaces the PAN for downstream systems; the token service, its keys, and its access paths remain in scope.`,
      `Segmentation is ${values.segmentation.toFixed(0)}% enforced. A boundary that is not default-deny and monitored is a diagram, and the systems behind it remain connected.`,
      `Data minimization is ${values.minimization.toFixed(0)}%. Every analytics copy, support export, and debug dump that keeps card data expands the environment that must be assessed.`,
      `Discovery is ${values.discovery.toFixed(0)}% and the illustrative scope is ${values.scopeSystems} systems. Scope is a measurement of what exists, not a target chosen for the questionnaire.`,
    ];
  },
  legend: [
    { label: "Outside card-data path", tone: "ok" },
    { label: "Partial control", tone: "warn" },
    { label: "Card data present", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Payment paths are tokenized before storage, the card-data environment is segmented, copies are minimized, and flows are inventoried.",
    tone: "ok",
    params: defaults({ tokenization: 100, segmentation: 100, minimization: 100, discovery: 100 }),
  },
  {
    id: "peak",
    label: "Tokenized core",
    description: "The primary payment path is tokenized and segmented, but analytics and support copies are only partly minimized and some flows are undiscovered.",
    tone: "warn",
    params: defaults({ tokenization: 90, segmentation: 70, minimization: 80, discovery: 80 }),
  },
  {
    id: "failure",
    label: "Platform in scope",
    description: "Most services receive card data, segmentation is loose, copies are kept for analytics, and a large share of flows is not inventoried.",
    tone: "crit",
    params: defaults({ tokenization: 10, segmentation: 20, minimization: 30, discovery: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Tokenization is at the edge, the remaining environment is segmented, copies are removed, and flows are inventoried.",
    tone: "ok",
    params: defaults({ tokenization: 100, segmentation: 95, minimization: 100, discovery: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-encryption-scope",
  title: "Predict whether encryption removes a system from scope",
  simId: "pci-dss",
  question:
    "A warehouse stores a copy of the primary account number encrypted at rest with a customer-managed key. The payment path is not tokenized. Can the warehouse be excluded from the card-data environment?",
  prediction: {
    options: [
      { id: "exclude", label: "Yes. Strong encryption at rest removes the data from scope" },
      { id: "include", label: "No. The warehouse still stores cardholder data; encryption does not by itself remove it from scope" },
      { id: "network", label: "Yes, if the warehouse is on a separate subnet" },
      { id: "vendor", label: "Only if the warehouse vendor signs a contract" },
    ],
    correctOptionId: "include",
    explanation:
      "PCI scope follows cardholder data and the systems that store, process, transmit, or can reach it. An encrypted copy is still a copy of cardholder data, and the warehouse still has access to the key and the plaintext. Encryption is a control that protects the data; tokenization removes the PAN so downstream systems handle a surrogate instead.",
  },
  setup: defaults({ tokenization: 0, segmentation: 100, minimization: 100, discovery: 100 }),
  runFor: 20,
  observe: [
    "Card data reaches uncontrolled systems on 100% of modeled paths even though segmentation is complete.",
    "The tokenization gap, not the network boundary, sets the scope metric.",
    "The analytics warehouse and checkout nodes fail while the token service stays present but bypassed.",
    "Setting tokenization to 100 and restoring the payment path clears the critical threshold.",
  ],
  explain:
    "The warehouse is connected to card data by the copy itself, not only by the network route. Encryption protects the copy and reduces some risk, but it does not change the fact that the system stores the PAN and can read it. Tokenization changes the data: downstream systems receive a surrogate they cannot reverse, so the PAN no longer reaches them. The token service and its keys stay in scope, which is the tradeoff: a smaller boundary with a concentrated, high-value service.",
  fix: defaults({ tokenization: 100, segmentation: 95, minimization: 100, discovery: 100 }),
  debrief:
    "After tokenization, the warehouse no longer handles a PAN and the modeled uncontrolled reach falls to zero. The remaining scope is the token service, the card-data environment, and the paths that can reach them. That is the point of scope reduction: not fewer controls everywhere, but fewer systems that need the full control set. This module is engineering education, not a PCI assessment or legal advice; the applicable standard, self-assessment questionnaire, and scope decision belong with a qualified assessor.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Payment Card Industry Data Security Standard (PCI DSS) is a set of technical and operational requirements for entities that store, process, or transmit cardholder data, or that can affect the security of the cardholder data environment (CDE). The standard is maintained by the PCI Security Standards Council. For engineers, the practical problem is scope: every system that touches the primary account number (PAN) or can reach a system that does inherits a large control set.",
  },
  {
    type: "p",
    text: "Scope reduction changes the architecture so fewer systems handle card data. Tokenization replaces the PAN with a surrogate before it reaches downstream services. Segmentation puts the remaining CDE behind an enforced boundary. Data minimization removes copies that have no business need. Discovery finds the paths nobody documented. None of these is a paperwork exercise; each one changes which systems an assessor must examine.",
  },
  {
    type: "p",
    text: "Encryption is not a scope-removal button. An encrypted copy of the PAN is still cardholder data, and the system that holds the key can read it. Encryption is required in many places and reduces risk, but tokenization is the architectural move that keeps the PAN out of most systems in the first place.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The payment path starts at the client and ends at the processor or acquirer. The CDE is the set of systems between those points that store, process, or transmit card data, plus connected systems that can affect its security. The audit boundary is drawn around that set, so a shortcut through analytics, support, or logging quietly expands it.",
  },
  {
    type: "table",
    headers: ["Scope reducer", "What changes", "What it does not fix"],
    rows: [
      ["Tokenization", "Downstream systems receive a surrogate instead of the PAN", "The token service, its keys, and detokenization paths stay in scope"],
      ["Segmentation", "Default-deny network and identity boundaries around the CDE", "A documented boundary that is not enforced or monitored"],
      ["Minimization", "Copies for analytics, support, and debugging are removed", "Data already copied to unknown stores"],
      ["Discovery", "Every flow that can reach card data is inventoried", "A flow that exists but was never tested"],
    ],
  },
  {
    type: "p",
    text: "The interaction is what makes scope hard. Tokenization without discovery leaves a legacy export. Segmentation without minimization leaves a copy inside the boundary. Minimization without tokenization removes one copy while the payment path keeps creating new ones. The weakest reducer sets the practical boundary.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Card data reaching uncontrolled systems: the share of modeled paths where a PAN or reversible copy leaves the intended boundary.",
      "Scope reduction gap: the complement of the weakest of tokenization, segmentation, minimization, and discovery.",
      "Undiscovered card-data flows: paths that are not in the inventory.",
      "Illustrative in-scope systems: a teaching count derived from the four reducers, not a real assessment result.",
      "Node states: storefront, checkout, token service, CDE, analytics warehouse, and support console.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Tokenized core and note that a strong payment path still leaves a warning when copies and discovery lag. Apply Platform in scope and watch card data reach the warehouse and support console. Run the experiment before revealing the explanation, then apply Recovery and compare the scope count.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not a PCI assessment or legal advice. The applicable requirements, validation method, and scope decision depend on the entity, the payment channels, and the current standard. Work with a qualified assessor and your acquirer for a real determination.",
  },
  { type: "sim", simId: "pci-dss" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Segmentation and minimization were complete, but tokenization was off, so card data still reached the analytics warehouse and the scope metric stayed at its worst. The network boundary did not help because the copy was made inside the environment and then moved out. The checkout and warehouse nodes failed while the token service existed but was bypassed.",
  },
  {
    type: "p",
    text: "Turning on tokenization reduced uncontrolled reach to zero and shrank the illustrative scope. The token service and its keys remained in scope, which is the intended tradeoff: concentrate card data in one high-value service and remove it from everything else.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Payment entry: browser or device posts card data directly to the token service or processor.",
      "Data flow: which services receive a PAN, a token, or nothing, verified from traffic rather than diagrams.",
      "Token service: key custody, detokenization authorization, availability, and audit.",
      "Segmentation: default-deny policy, allowed paths, and alerts on denied attempts.",
      "Copies: analytics, support, logs, backups, and vendor exports that contain card data.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every system that receives a PAN, including logs and support tools.",
      "Trace one payment from the client to the processor and mark where the PAN becomes a token.",
      "Check whether downstream services can detokenize without an approved, audited path.",
      "Verify segmentation with traffic data and default-deny policy, not only a network diagram.",
      "Find analytics, backup, and vendor copies created before tokenization was added.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Move tokenization to the earliest point where the PAN is no longer needed.",
      "Restrict detokenization to a small set of identities and log every use.",
      "Remove card data from analytics, support, and debug copies.",
      "Enforce the CDE boundary with default-deny network and identity policy.",
      "Re-inventory flows after every new integration or vendor connection.",
      "Test the boundary end to end and confirm the scope count matches the inventory.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Tokenization shrinks scope and adds a high-value token service that must be highly available and carefully keyed.",
      "Segmentation reduces the boundary and adds network complexity, break-glass paths, and operational friction.",
      "Minimizing stored data reduces risk and can remove history needed for disputes, reconciliation, or customer support.",
      "Vendor tokenization moves key custody and availability risk to a third party while reducing internal scope.",
      "A narrow scope is cheaper to assess but concentrates risk; a broad scope is simpler architecturally but expensive to control.",
      "Discovery is continuous work. A one-time inventory is stale as soon as a new integration ships.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "scope-boundary",
    question: "How do you determine which systems are in scope for PCI DSS?",
    difficulty: 2,
    hints: [
      "Start from cardholder data, not from the network diagram.",
      "Include systems that can affect the security of the CDE.",
    ],
    answer:
      "I start with the data: where the PAN is received, transmitted, stored, and copied, including logs, analytics, backups, and vendor exports. Then I add systems that can affect the security of that environment, such as hypervisors, identity providers, jump hosts, and management planes. I validate the inventory with traffic and access data rather than relying on an architecture diagram. The output is a boundary with evidence, and I re-run it after new integrations because scope drifts.",
    followUps: [
      "How do you treat a system that only sees tokens?",
      "What changes when a vendor processes card data on your behalf?",
      "How would you prove the boundary is enforced?",
    ],
    redFlags: [
      "Scopes only the payment service.",
      "Trusts a diagram without traffic validation.",
      "Ignores management and support paths.",
    ],
    rubric: [
      "Starts from cardholder data flows.",
      "Includes connected and supporting systems.",
      "Validates with evidence.",
      "Treats scope as continuous.",
    ],
  },
  {
    id: "tokenization-tradeoff",
    question:
      "Leadership wants tokenization to remove the warehouse from scope. What conditions make that true, and what stays in scope?",
    difficulty: 3,
    hints: [
      "A token must not be reversible by the downstream system.",
      "The token service and key material still matter.",
    ],
    answer:
      "It is true only if the warehouse receives a surrogate that it cannot reverse and never receives the PAN or a key that can recover it. The token service, its key custody, the detokenization authorization path, and any system that can call detokenization remain in scope. I would verify with a real payment that the warehouse payload contains no PAN, check retention and logs for accidental copies, and confirm that a compromised warehouse cannot detokenize. The tradeoff is a concentrated token service that becomes a high-value dependency.",
    followUps: [
      "What if the vendor token is reversible by the vendor?",
      "How do you test that no PAN reaches the warehouse?",
      "What availability risk does the token service add?",
    ],
    redFlags: [
      "Assumes any token removes scope.",
      "Ignores detokenization paths.",
      "Forgets keys and logs.",
    ],
    rubric: [
      "Defines an irreversible surrogate.",
      "Keeps the token service in scope.",
      "Verifies with data, not a diagram.",
      "Names the concentration tradeoff.",
    ],
  },
  {
    id: "segmentation-proof",
    question: "How would you prove that segmentation actually reduces scope?",
    difficulty: 3,
    hints: [
      "Policy, traffic, and identity all have to agree.",
      "Look for alternate paths such as management and support.",
    ],
    answer:
      "I would show three things: the policy denies by default, the traffic data shows only the allowed paths, and identity boundaries prevent a non-CDE principal from reaching CDE resources. Then I would test alternate paths: management planes, backup networks, support tools, and vendor connections. A diagram or a firewall rule alone is not proof. If any path bypasses the boundary, the connected systems come back into scope, so I would fix the path before claiming the reduction.",
    followUps: [
      "How often would you re-test the boundary?",
      "What do you do with a break-glass path?",
      "How does a shared Kubernetes cluster affect segmentation?",
    ],
    redFlags: [
      "Treats a VLAN as segmentation.",
      "Does not test management paths.",
      "Claims scope reduction without traffic evidence.",
    ],
    rubric: [
      "Checks policy and traffic.",
      "Includes identity boundaries.",
      "Tests alternate paths.",
      "Re-tests after change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the assessment",
    items: [
      "Inventory every system that stores, processes, transmits, or can reach cardholder data.",
      "Mark where the PAN becomes a token and who can detokenize.",
      "List analytics, support, backup, and vendor copies.",
      "Verify the CDE boundary with default-deny policy and traffic data.",
    ],
  },
  {
    title: "During the assessment",
    items: [
      "Trace one payment end to end and record every system that sees the PAN.",
      "Test whether a downstream system can reverse a token.",
      "Check management and support paths into the CDE.",
      "Confirm the scope count matches the inventory and the evidence.",
    ],
  },
  {
    title: "After the assessment",
    items: [
      "Remove card data from copies that have no documented need.",
      "Restrict and audit detokenization identities.",
      "Re-inventory after new integrations and vendor connections.",
      "Re-test the boundary before expanding the scope claim.",
    ],
  },
];

const references = [
  {
    title: "PCI Data Security Standard (PCI DSS)",
    url: "https://www.pcisecuritystandards.org/standards/pci-dss/",
    publisher: "PCI Security Standards Council",
    kind: "standard" as const,
    note: "Official standard overview, including the cardholder data environment and the audience for PCI DSS.",
  },
  {
    title: "PCI SSC Document Library",
    url: "https://www.pcisecuritystandards.org/document_library/",
    publisher: "PCI Security Standards Council",
    kind: "docs" as const,
    note: "Official library for the current PCI DSS standard, supporting documents, and scope guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "pci-dss": {
      model: pciDssModel,
      presets,
      instructions:
        "Start Healthy, then apply Tokenized core and Platform in scope. Compare tokenization with segmentation and discovery. Run the experiment before revealing the explanation, then apply Recovery and watch the illustrative scope count fall as card data leaves downstream systems.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages, the scope-system count, and the 15/35 thresholds are teaching values, not assessment results. A real PCI DSS scope decision depends on the entity, the payment channels, and a qualified assessor.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-data-classification", "compliance-phi", "compliance-audit-trails"],
};
