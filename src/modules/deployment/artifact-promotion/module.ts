import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "promotionMode",
    label: "Rebuild during promotion (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Promotion",
    help: "One means production builds its own artifact from source instead of promoting the digest approved in staging.",
    format: "count",
  },
  {
    id: "provenanceCoverage",
    label: "Provenance coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Audit",
    help: "Share of promoted artifacts with a signed record of source, builder, and inputs.",
    format: "percent",
  },
  {
    id: "envConfigKeys",
    label: "Production config keys",
    min: 0,
    max: 50,
    step: 1,
    value: 8,
    unit: " keys",
    group: "Config",
    help: "Settings applied separately by the production environment at promotion time, such as endpoints, limits, and credentials references.",
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

interface Values {
  rebuild: boolean;
  untestedExposure: number;
  provenanceGap: number;
  configRiskKeys: number;
}

function compute(p: Params): Values {
  const rebuild = num(p, "promotionMode", 0) >= 0.5;
  const provenance = clamp(num(p, "provenanceCoverage", 100) / 100, 0, 1);
  const configKeys = Math.max(0, num(p, "envConfigKeys", 8));

  return {
    rebuild,
    untestedExposure: rebuild ? 100 : 0,
    provenanceGap: (1 - provenance) * 100,
    configRiskKeys: Math.round(configKeys * (rebuild ? 0.6 : 0.2)),
  };
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const identityHealth = highHealth(values.untestedExposure, 1, 20);
  const provenanceHealth = highHealth(values.provenanceGap, 5, 20);
  const productionHealth = worst(identityHealth, provenanceHealth);

  const stageNodes = [
    {
      id: "staging",
      label: "Staging gate",
      kind: "service" as const,
      health: "ok" as Health,
      utilization: 0.3,
      sublabel: "approved digest sha256:8b7d…",
      detail: "The staging gate approved a specific digest after tests and review. The promotion record should carry that digest forward.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "promotion",
      label: "Promotion controller",
      kind: "service" as const,
      health: worst(identityHealth, provenanceHealth),
      utilization: clamp(values.untestedExposure / 100),
      sublabel: values.rebuild ? "rebuild requested · identity lost" : "promote digest + provenance",
      detail: values.rebuild
        ? "The controller builds a new artifact for production. The approved staging digest is not what production runs."
        : "The controller passes the approved digest and its provenance to production. Environment configuration is attached separately.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "production",
      label: "Production",
      kind: "service" as const,
      health: productionHealth,
      utilization: clamp(values.untestedExposure / 100),
      sublabel: values.rebuild ? "untested artifact · new build" : "approved digest · config applied",
      detail: `Production receives ${values.rebuild ? "a fresh build that never passed the staging gate" : "the artifact the staging gate approved"}. ${values.configRiskKeys} environment keys are applied separately.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "gate", label: "Staging gate", kind: "service" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "controller",
      label: "Promotion",
      kind: "worker" as const,
      health: worst(identityHealth, provenanceHealth),
      sublabel: values.rebuild ? "rebuild" : "same digest",
      meta: { view: "flow" },
    },
    {
      id: "prod",
      label: "Production",
      kind: "service" as const,
      health: productionHealth,
      sublabel: `${values.configRiskKeys} config keys`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("gate-controller", "gate", "controller", clamp(1 - values.untestedExposure / 100), identityHealth),
      edge("controller-prod", "controller", "prod", clamp(values.untestedExposure / 100), productionHealth),
    ],
    metrics: [
      metric("untested-exposure", "Untested artifact exposure", values.untestedExposure, "%", 1, 20, "percent"),
      metric("provenance-gap", "Provenance gap", values.provenanceGap, "%", 5, 20, "percent"),
      metric("config-risk-keys", "Unreviewed config keys", values.configRiskKeys, " keys", 3, 10, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), untestedExposure: values.untestedExposure },
    summary: `${percent(values.untestedExposure)} untested exposure · ${percent(values.provenanceGap)} provenance gap · ${values.configRiskKeys} config keys`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 4)) / 2.1);
  for (const [id, value] of [
    ["untested-exposure", values.untestedExposure],
    ["provenance-gap", values.provenanceGap],
    ["config-risk-keys", values.configRiskKeys],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "untested-exposure",
    metricId: "untested-exposure",
    warn: 1,
    crit: 20,
    title: "Production runs an artifact the staging gate never approved",
    cause: "The promotion step rebuilds from source instead of promoting the approved digest. The new build may differ in dependencies, base layers, or build flags, so the staging result no longer applies.",
    fix: "Promote the approved digest, not a new build. Record the digest in the promotion decision and reject any production artifact whose digest is not on the approved list.",
    checkFirst: [
      "Compare the staging-approved digest with the production running digest.",
      "Check whether the promotion job contains a build step.",
      "Check the promotion record for the artifact identity it carried forward.",
    ],
  },
  {
    id: "provenance-gap",
    metricId: "provenance-gap",
    warn: 5,
    crit: 20,
    title: "The promotion cannot be audited",
    cause: "The artifact has no signed record of source, builder, and inputs, or the record was not carried with the promotion. The team cannot prove what was approved or reproduce it.",
    fix: "Generate provenance at build time and promote it with the digest. Require a verified attestation at production admission and retain it with the release record.",
    checkFirst: [
      "Check whether provenance exists for the promoted digest.",
      "Check whether the signature and builder identity are valid.",
      "Check whether the promotion record links approval, digest, and config.",
    ],
  },
  {
    id: "config-risk-keys",
    metricId: "config-risk-keys",
    warn: 3,
    crit: 10,
    title: "Promotion applies configuration without a review trail",
    cause: "Environment configuration is changed as part of the production promotion without the same validation or review as the artifact. The code may be identical while production behavior is not.",
    fix: "Apply environment config separately with a typed schema and review trail. Keep the artifact promotion and the config change as distinct, auditable steps.",
    checkFirst: [
      "Check which config keys changed during promotion.",
      "Check whether the values were validated against a schema.",
      "Check whether the config change has an approver and a rollback value.",
    ],
  },
];

export const artifactPromotionModel: SimModel = {
  id: "deployment-artifact-promotion",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (resetSeries) seedSeries(next, values, seed);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      values.rebuild
        ? "Promotion rebuilds the software for production, so the approved staging digest is not what runs."
        : "Promotion carries the approved digest forward. The staging result still describes what production runs.",
    );
    items.push(
      `Provenance covers ${percent(100 - values.provenanceGap)} of the promoted artifact. Without it, the approval cannot be tied to source and builder.`,
    );
    items.push(
      `${Math.round(num(p, "envConfigKeys", 8))} production config keys are applied separately; ${values.configRiskKeys} are outside the review trail.`,
    );
    items.push(
      "The promotion record is only useful if it names the digest, the approval, the provenance, and the environment config together.",
    );
    return items;
  },
  legend: [
    { label: "Promoted", tone: "ok" },
    { label: "Partial record", tone: "warn" },
    { label: "Unverified", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The approved digest and provenance are promoted, with eight reviewed config keys.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial record",
    description: "The digest is promoted, but provenance has gaps and config review is incomplete.",
    tone: "warn",
    params: defaults({ promotionMode: 0, provenanceCoverage: 90, envConfigKeys: 30 }),
  },
  {
    id: "failure",
    label: "Rebuild on promote",
    description: "Production rebuilds the artifact with weak provenance and forty environment keys.",
    tone: "crit",
    params: defaults({ promotionMode: 1, provenanceCoverage: 20, envConfigKeys: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Promote the approved digest with full provenance and a reviewed config set.",
    tone: "ok",
    params: defaults({ promotionMode: 0, provenanceCoverage: 100, envConfigKeys: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-promotion",
  title: "Predict what moves during a promotion",
  simId: "promotion",
  question:
    "Staging approved a release and production needs one environment-specific endpoint. What should the promotion carry to production?",
  prediction: {
    options: [
      { id: "digest", label: "The approved digest and provenance, plus separately applied config" },
      { id: "rebuild", label: "A fresh production build with the endpoint baked in" },
      { id: "source", label: "The source commit and build instructions for production" },
      { id: "tag", label: "The staging tag and a note to rebuild if needed" },
    ],
    correctOptionId: "digest",
    explanation:
      "Promotion moves the tested software identity and the evidence that it was tested. The environment endpoint is configuration and should be applied, validated, and audited separately. A rebuild or a source handoff creates a new artifact whose behavior was never tested in staging.",
  },
  setup: defaults({ promotionMode: 1, provenanceCoverage: 20, envConfigKeys: 40 }),
  runFor: 30,
  observe: [
    "Untested artifact exposure is 100%: production runs a build the staging gate never saw.",
    "The provenance gap is 80%, so the promotion cannot be tied to source and builder.",
    "Twenty-four config keys are outside the review trail.",
    "The failure is in the promotion identity, not in the application request path.",
  ],
  explain:
    "The promotion step is where the tested artifact identity is either preserved or lost. Rebuilding creates a new identity; baking environment config into that rebuild makes the change larger. Promotion should move the digest and provenance, then apply validated config as a separate audited step.",
  fix: defaults({ promotionMode: 0, provenanceCoverage: 100, envConfigKeys: 10 }),
  debrief:
    "The fixed promotion carries one digest, complete provenance, and a small reviewed config set. The tradeoff is that config is a second change with its own approval and rollback, but that separation is what makes the audit trail meaningful.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Artifact promotion is the step that moves a tested artifact from one environment to the next. A promotion record should answer four questions: which digest was approved, what evidence was attached, which environment config was applied, and who approved the transition. The answer is not a source commit or a tag; it is the exact artifact identity plus the provenance that explains where it came from.",
  },
  {
    type: "p",
    text: "The promotion step is also where teams accidentally create a new artifact. A pipeline that rebuilds for production has not promoted anything; it has produced a second build that never passed the staging gate. Even when the source is identical, dependencies and build inputs can differ. The audit trail then describes a release that production never ran.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A staging gate approves a digest. The promotion controller carries that digest, its provenance, and the approval into production. A configuration system applies environment values separately, with its own schema and review. A production admission check verifies the digest and attestation before the workload starts. The release record ties the four pieces together.",
  },
  {
    type: "p",
    text: "The coverage, key counts, and exposure values here are illustrative. The structural rule is that promotion moves identity and evidence; configuration is a separate, validated change.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Untested artifact exposure: the share of production running an artifact staging never approved.",
      "Provenance gap: promoted artifacts without a verifiable source and builder record.",
      "Unreviewed config keys: environment values applied without a review trail.",
      "A promotion controller that either passes the digest or rebuilds it.",
      "Staging, promotion, and production nodes with the same or different identity.",
    ],
  },
  {
    type: "table",
    headers: ["Promotion style", "What moves", "Audit result", "Risk"],
    rows: [
      ["Digest plus provenance", "Tested identity and evidence", "Traceable to source and approval", "Config remains separate"],
      ["Mutable tag", "A name that may resolve differently", "Ambiguous", "Different bytes per environment"],
      ["Source handoff", "Instructions to build", "New artifact, new risk", "Build differs from tested"],
      ["Rebuild on promote", "A new production build", "Staging result invalid", "Untested artifact exposure"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and check that the staging and production digests match. Apply Rebuild on promote: untested exposure and provenance gaps rise together. Apply Partial record to separate identity from evidence. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "promotion" },
  { type: "experiment", experimentId: "predict-promotion" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the promotion controller rebuilt the artifact for production. Untested exposure reached 100%, provenance covered only 20%, and 24 config keys were outside the review trail. The staging gate had approved a digest, but production never ran it.",
  },
  {
    type: "p",
    text: "The partial-record preset shows the quieter gap: the digest was promoted, but provenance and config review were incomplete. The artifact identity was correct; the evidence and configuration were not. An audit would still struggle to connect approval to production behavior.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A production digest that differs from the digest in the staging approval.",
      "A promotion job with a build step after the gate.",
      "Missing or unsigned provenance for the running artifact.",
      "Config keys changed at promotion time with no linked review.",
      "An audit that can name the release but not the exact artifact or builder.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the staging-approved digest with production's running digest. Check whether promotion rebuilds. Check provenance for source and builder. Check which config keys were applied during promotion and whether they were reviewed.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Promote the approved digest and reject any other digest at production admission.",
      "Carry provenance with the digest and verify it before start.",
      "Apply environment config separately with a typed schema and review trail.",
      "Record approval, digest, provenance, and config in one release record.",
      "Test a promotion and a rollback using the same record.",
      "Alert on any production digest that is not on the approved list.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Digest promotion is auditable but requires artifact retention and admission checks.",
      "Separate config review adds a step but keeps environment changes visible.",
      "Full provenance improves investigation but adds build-system and key management work.",
      "A rebuild can be faster for a hotfix but destroys the link to the staged result.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-moves",
    question: "What exactly moves to production when a release is promoted?",
    difficulty: 2,
    hints: [
      "Identity, not a source reference.",
      "Evidence travels with it.",
      "Config is separate.",
    ],
    answer:
      "The approved artifact digest and its provenance move to production, along with the approval record. Environment configuration is applied separately through a validated, reviewed path. The promotion record ties the digest, the staging evidence, the config change, and the approver together. What does not move is a source commit that production rebuilds, or a mutable tag that may resolve to different bytes.",
    followUps: [
      "How do you verify the digest at production admission?",
      "Where does the config review live?",
      "What if the previous digest is needed for rollback?",
    ],
    redFlags: ["Says the source commit moves.", "Promotes a tag.", "Bundles config into the artifact."],
    rubric: ["Names digest.", "Includes provenance and approval.", "Separates config.", "Mentions verification."],
  },
  {
    id: "audit",
    question:
      "An auditor asks what ran in production last Tuesday. What must the promotion record contain?",
    difficulty: 3,
    hints: [
      "Exact artifact identity.",
      "Source and builder.",
      "Environment config and approval.",
    ],
    answer:
      "It needs the running digest, the provenance that links it to source and builder, the staging gate results, the production config applied, the approval identity, and the deployment timestamps. With that I can prove which artifact ran, what was tested, who approved it, and which configuration shaped its behavior. If any of those are missing, the answer is partial.",
    followUps: [
      "How long do you retain the record?",
      "How do you prove the record was not altered?",
      "What if the artifact was rebuilt?",
    ],
    redFlags: ["Records only a version string.", "Cannot name the builder.", "Ignores config."],
    rubric: ["Names digest.", "Includes provenance.", "Includes config and approval.", "States retention."],
  },
  {
    id: "hotfix",
    question: "A hotfix must reach production in ten minutes. How do you preserve promotion integrity?",
    difficulty: 2,
    hints: [
      "Build once, then promote the digest.",
      "Speed comes from preparation, not from skipping identity.",
      "Rollback still needs the previous digest.",
    ],
    answer:
      "I would use a pre-built hotfix path that still creates one artifact, runs the minimum required tests, records provenance, and promotes the digest. I would not rebuild in production or skip admission. The previous digest stays retained for rollback. If the emergency truly cannot wait, I would document the exception, verify the artifact after the fact, and add the missing gate before the next release.",
    followUps: [
      "Which tests are non-negotiable for a hotfix?",
      "Who can approve the exception?",
      "How do you verify the hotfix after deployment?",
    ],
    redFlags: ["Rebuilds in production.", "Skips all verification.", "Has no rollback artifact."],
    rubric: ["Builds once.", "Keeps minimum gates.", "Promotes digest.", "Documents exceptions."],
  },
];

const checklist = [
  {
    title: "Before promotion",
    items: [
      "Confirm the staging gate approved a specific digest.",
      "Verify provenance for source, builder, and inputs.",
      "Review the production config diff separately from the artifact.",
      "Confirm the previous digest is retained for rollback.",
    ],
  },
  {
    title: "During promotion",
    items: [
      "Promote the approved digest; do not rebuild.",
      "Verify the digest and attestation at production admission.",
      "Apply config through the validated path and record the values.",
      "Record approval, digest, and config in the release record.",
    ],
  },
  {
    title: "After promotion",
    items: [
      "Confirm the running digest matches the promotion record.",
      "Verify the rollback digest is still available.",
      "Audit any config change made outside the promotion.",
      "Add missing evidence or gates before the next release.",
    ],
  },
];

const references = [
  {
    title: "SLSA provenance",
    url: "https://slsa.dev/spec/v1.0/provenance",
    publisher: "Open Source Security Foundation",
    kind: "standard" as const,
    note: "Attestation linking a promoted digest to source, builder, and inputs.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Artifact promotion, reproducible builds, and release records.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    promotion: {
      model: artifactPromotionModel,
      presets,
      instructions:
        "Start with Healthy, then apply Rebuild on promote and compare the staging and production identity. Apply Partial record to separate evidence from identity. Run the experiment and apply its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Exposure, coverage, and config counts are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-immutable-artifacts", "deployment-build-once", "deployment-cicd", "deployment-config-drift"],
};
