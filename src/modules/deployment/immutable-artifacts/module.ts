import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "rebuildShare",
    label: "Deploys rebuilt per environment",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Build",
    help: "Share of deployments that compile or package the software again for each environment instead of promoting one artifact.",
    format: "percent",
  },
  {
    id: "digestVerification",
    label: "Digest verification at admission",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Control",
    help: "Share of deploys where the controller checks the image digest against the approved digest before starting.",
    format: "percent",
  },
  {
    id: "retentionDays",
    label: "Previous artifact retention",
    min: 0,
    max: 90,
    step: 1,
    value: 30,
    unit: "days",
    group: "Rollback",
    help: "How long the previous immutable artifact stays in the registry. Retention determines how fast a rollback can find the old bits.",
    format: "number",
  },
  {
    id: "provenanceCoverage",
    label: "Provenance coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Control",
    help: "Share of artifacts with a signed record linking digest, source commit, build system, and inputs.",
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

interface Values {
  rebuild: number;
  divergence: number;
  unverified: number;
  provenanceGap: number;
  lookupMinutes: number;
  variants: number;
}

function compute(p: Params): Values {
  const rebuild = clamp(num(p, "rebuildShare", 0) / 100, 0, 1);
  const verify = clamp(num(p, "digestVerification", 100) / 100, 0, 1);
  const provenance = clamp(num(p, "provenanceCoverage", 100) / 100, 0, 1);
  const retention = Math.max(0, num(p, "retentionDays", 30));

  const divergence = rebuild * 100;
  const unverified = (1 - verify) * 100;
  const provenanceGap = (1 - provenance) * 100;
  const lookupMinutes =
    retention >= 14 ? 3 : retention >= 7 ? 8 : 25 + (7 - retention) * 4;

  return {
    rebuild,
    divergence,
    unverified,
    provenanceGap,
    lookupMinutes,
    variants: rebuild > 0 ? 4 : 1,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const identityHealth = highHealth(values.divergence, 1, 10);
  const controlHealth = highHealth(values.unverified, 10, 25);
  const provenanceHealth = highHealth(values.provenanceGap, 5, 20);
  const rollbackHealth = highHealth(values.lookupMinutes, 10, 20);
  const productionHealth = worst(identityHealth, controlHealth);

  const stageNodes = [
    {
      id: "staging",
      label: "Staging artifact",
      kind: "service" as const,
      health: "ok" as Health,
      utilization: 0.3,
      sublabel: "sha256:4f2a… · tested",
      detail: "Staging ran the artifact that passed the test suite. The question is whether production runs the same digest.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "production",
      label: "Production artifact",
      kind: "service" as const,
      health: productionHealth,
      utilization: clamp(values.divergence / 100),
      sublabel: values.rebuild > 0 ? "rebuilt for production · different bytes" : "same digest · promoted",
      detail:
        values.rebuild > 0
          ? `Production was rebuilt for its environment, so ${percent(values.divergence)} of deployments carry bytes that never passed the staging gate.`
          : "Production starts the exact digest that staging tested. Environment behavior still depends on configuration, but the software is identical.",
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "registry",
      label: "Registry",
      kind: "storage" as const,
      health: worst(provenanceHealth, rollbackHealth),
      utilization: clamp(values.lookupMinutes / 60),
      sublabel: values.lookupMinutes >= 10 ? `previous digest expires · lookup ${values.lookupMinutes.toFixed(0)} min` : "retained · provenance attached",
      detail: `The registry retains the previous digest for ${Math.round(num(p, "retentionDays", 30))} days. A missing artifact turns rollback into a rebuild, and a rebuild produces different bits.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "build", label: "Build system", kind: "worker" as const, health: "ok" as Health, sublabel: "one build per commit", meta: { view: "flow" } },
    {
      id: "registry-flow",
      label: "Artifact registry",
      kind: "storage" as const,
      health: provenanceHealth,
      sublabel: `${percent(values.provenanceGap)} missing provenance`,
      meta: { view: "flow" },
    },
    {
      id: "prod",
      label: "Production",
      kind: "service" as const,
      health: productionHealth,
      sublabel: values.rebuild > 0 ? "different digest" : "approved digest",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("build-registry", "build", "registry-flow", clamp(values.rebuild > 0 ? 0.5 : 0.2), provenanceHealth),
      edge("registry-prod", "registry-flow", "prod", clamp(values.rebuild > 0 ? 1 : 0.3), productionHealth),
    ],
    metrics: [
      metric("artifact-divergence", "Artifact divergence", values.divergence, "%", 1, 10, "percent"),
      metric("unverified-deploys", "Deploys without digest check", values.unverified, "%", 10, 25, "percent"),
      metric("provenance-gap", "Provenance gap", values.provenanceGap, "%", 5, 20, "percent"),
      metric("rollback-lookup", "Rollback artifact lookup", values.lookupMinutes, "min", 10, 20, "number"),
      metric("artifact-variants", "Artifact variants per release", values.variants, " builds", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), divergence: values.divergence },
    summary: `${percent(values.divergence)} artifact divergence · ${percent(values.unverified)} unchecked deploys · rollback lookup ${values.lookupMinutes.toFixed(0)} min`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 9)) / 2.4);
  const series: [string, number][] = [
    ["artifact-divergence", values.divergence],
    ["unverified-deploys", values.unverified],
    ["provenance-gap", values.provenanceGap],
    ["rollback-lookup", values.lookupMinutes],
    ["artifact-variants", values.variants],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "artifact-divergence",
    metricId: "artifact-divergence",
    warn: 1,
    crit: 10,
    title: "Production is not running the tested artifact",
    cause: "The pipeline rebuilds the software for each environment. The same commit, toolchain, or dependency resolution can produce different bytes, so staging tested a different artifact than production runs.",
    fix: "Stop rebuilding per environment. Build one artifact, publish it by digest, and promote that digest. Make the deployment controller reject any digest that is not the approved one.",
    checkFirst: [
      "Compare the running image digest in staging and production, not the tag.",
      "Check whether the deploy job runs a build step after the promotion gate.",
      "Check the artifact creation time and source commit recorded in provenance.",
    ],
  },
  {
    id: "unverified-deploys",
    metricId: "unverified-deploys",
    warn: 10,
    crit: 25,
    title: "Deploys can start without a digest check",
    cause: "A mutable tag or a missing admission check lets the controller deploy whatever the tag points to at that moment. Tags can be overwritten, and two environments can resolve the same tag to different digests.",
    fix: "Deploy by digest and verify the digest at admission. Record the approved digest in the release record and alert on any deployment that did not present it.",
    checkFirst: [
      "Check whether the deployment spec references a tag or a digest.",
      "Check admission-controller logs for digest verification decisions.",
      "Check the registry for tag mutations around the deploy time.",
    ],
  },
  {
    id: "provenance-gap",
    metricId: "provenance-gap",
    warn: 5,
    crit: 20,
    title: "Artifacts lack a verifiable build record",
    cause: "Without provenance, the registry cannot prove which source, builder, and inputs produced the digest. That makes a supply-chain or rebuild difference hard to investigate.",
    fix: "Generate signed provenance at build time and attach it to the digest. Verify it before promotion and retain it with the release record.",
    checkFirst: [
      "Check whether the digest has a signed provenance attestation.",
      "Compare the recorded source commit with the release branch.",
      "Check whether the builder identity is the expected one.",
    ],
  },
  {
    id: "rollback-lookup",
    metricId: "rollback-lookup",
    warn: 10,
    crit: 20,
    title: "The previous artifact is expensive to restore",
    cause: "Short retention deletes the digest that rollback needs. The team then rebuilds from source, which is slower and produces different bits, so rollback no longer restores the known-good software.",
    fix: "Retain previous production artifacts for at least the rollback and audit window. Reference rollback by digest, and test restoring it before the release.",
    checkFirst: [
      "Check whether the previous digest still exists in the registry.",
      "Check retention policy against the rollback window.",
      "Time a restore of the previous digest in a non-production environment.",
    ],
  },
];

export const immutableArtifactsModel: SimModel = {
  id: "deployment-immutable-artifacts",
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
    if (values.divergence > 0) {
      items.push(
        `Production was rebuilt, so ${percent(values.divergence)} of deploys run bytes that staging never tested. A tag cannot prove identity; a digest can.`,
      );
    } else {
      items.push("Production promotes the same digest that staging tested. The software identity is preserved.");
    }
    items.push(
      `Digest verification covers ${percent(100 - values.unverified)} of deploys. Unverified deploys are where a mutable tag or an accidental rebuild enters production.`,
    );
    items.push(
      `Provenance covers ${percent(100 - values.provenanceGap)} of artifacts. Provenance links digest, commit, and builder, which is what you need when the two environments disagree.`,
    );
    items.push(
      `The previous artifact lookup takes ${values.lookupMinutes.toFixed(0)} minutes at the current retention. Rollback speed depends on the digest still existing, not on a rebuild.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Drifting", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Build once, promote by digest, retain the previous artifact, and verify provenance.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial rebuilds",
    description: "Five percent of deploys rebuild for an environment and provenance coverage has gaps.",
    tone: "warn",
    params: defaults({ rebuildShare: 5, digestVerification: 95, retentionDays: 14, provenanceCoverage: 90 }),
  },
  {
    id: "failure",
    label: "Rebuilt production",
    description: "Every environment rebuilds, digest checks are weak, and the previous artifact is nearly expired.",
    tone: "crit",
    params: defaults({ rebuildShare: 100, digestVerification: 20, retentionDays: 2, provenanceCoverage: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "One build per commit, digest admission, full provenance, and a retained rollback artifact.",
    tone: "ok",
    params: defaults({ rebuildShare: 0, digestVerification: 100, retentionDays: 30, provenanceCoverage: 100 }),
  },
  {
    id: "rebuild-only",
    label: "Rebuild only",
    description: "Verification and provenance are healthy, but every environment still rebuilds.",
    tone: "crit",
    params: defaults({ rebuildShare: 100, digestVerification: 100, retentionDays: 30, provenanceCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-artifact-identity",
  title: "Predict which control catches a different build",
  simId: "artifact-flow",
  question:
    "Staging passed and production was rebuilt from the same commit, but behaves differently. Which control would have detected that production was not the tested artifact?",
  prediction: {
    options: [
      { id: "digest", label: "Deploying and admitting the approved image digest" },
      { id: "tests", label: "Running the staging test suite for longer" },
      { id: "capacity", label: "Adding more production instances" },
      { id: "tag", label: "Promoting the same mutable tag to production" },
    ],
    correctOptionId: "digest",
    explanation:
      "A digest is derived from the artifact content. If production admits only the digest that staging tested, a rebuild cannot enter production unnoticed. A tag is a pointer and can resolve to different bytes; more tests or instances do not prove identity.",
  },
  setup: defaults({ rebuildShare: 100, digestVerification: 20, retentionDays: 2, provenanceCoverage: 10 }),
  runFor: 30,
  observe: [
    "Artifact divergence is 100%: production runs bytes that staging never tested.",
    "Seventy-five percent of deploys start without a digest check.",
    "The provenance gap is 90%, so the build record cannot explain the difference.",
    "Rollback lookup takes 45 minutes because the previous digest has expired.",
  ],
  explain:
    "Rebuilding is not the same as promoting. Compilers, base images, dependency resolution, and build flags can change between builds, so the same commit can produce a different artifact. The deployment identity must be the digest, and admission must compare it with the digest that passed the gate.",
  fix: defaults({ rebuildShare: 0, digestVerification: 100, retentionDays: 30, provenanceCoverage: 100 }),
  debrief:
    "The fixed path builds once, verifies the digest at admission, and retains the previous artifact for rollback. Environment configuration still differs, which is the subject of Build Once, Deploy Many. What changed here is that the software identity is provable and the rollback unit exists.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An immutable artifact is the output of one build that is never rebuilt for a later environment. It is identified by a digest, a cryptographic hash of its content, and promoted by passing that same digest through staging, production, and rollback. Immutability is a property of the release process, not of the storage service: a registry can store mutable tags, and a pipeline can rebuild the same commit into different bytes.",
  },
  {
    type: "p",
    text: "A tag such as app:latest or app:v42 is a human-readable pointer. It can be moved, overwritten, or resolved differently in two environments. A digest such as sha256:4f2a... names exact content. Two deployments that reference the same digest run the same software; two deployments that reference the same tag do not necessarily do so. Provenance is the signed record that connects the digest to the source commit, builder, and inputs.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The artifact sits between continuous integration (CI) and the deployment controller. CI builds once, writes the artifact to a registry, and records its digest. The promotion gate approves that digest, and each environment's deploy step references it. The registry must retain the digest for at least the rollback and audit window; otherwise rollback becomes a rebuild.",
  },
  {
    type: "p",
    text: "This model uses illustrative values for rebuild share, verification coverage, retention, and provenance. The shape is the lesson: rebuilding changes the software, a mutable tag hides the change, and short retention removes the rollback unit. Environment-specific configuration is deliberately out of scope here and is covered in the next module.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Artifact divergence: the share of deployments whose production bytes differ from the tested artifact.",
      "Deploys without a digest check: the share that could run an unapproved artifact.",
      "Provenance gap: artifacts with no verifiable record of source and builder.",
      "Rollback artifact lookup: how long it takes to find the previous digest.",
      "Artifact variants per release: one build, or one per environment.",
    ],
  },
  {
    type: "table",
    headers: ["Reference", "What it guarantees", "What it does not"],
    rows: [
      ["Mutable tag", "A readable name that resolves now", "Same bytes later, or in another environment"],
      ["Image digest", "Exact content identity", "That the content is safe or correctly configured"],
      ["Signed provenance", "Who built what, from which inputs", "That the build passed every functional gate"],
      ["Retained artifact", "Rollback can restore known bits", "That the old version is compatible with new data"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and compare the staging and production nodes. Apply Rebuilt production: divergence and unverified deploys rise together, while the registry shows an expired rollback path. Apply Rebuild only to isolate the rebuild from the verification gap. Then run the experiment and apply its fix.",
  },
  { type: "sim", simId: "artifact-flow" },
  { type: "experiment", experimentId: "predict-artifact-identity" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, every environment rebuilt the software. Divergence reached 100%, meaning production bytes were not the bytes staging tested. Only 20% of deploys verified a digest, so even a correct build could be replaced by a tag change. Provenance covered 10% of artifacts, and a two-day retention made the previous artifact a 45-minute lookup or a fresh rebuild.",
  },
  {
    type: "p",
    text: "The Rebuild only preset isolates the core failure: verification and provenance were healthy, but rebuilding alone still produced a different artifact. That is why digest verification is not a substitute for build once. Verification proves which bytes are running; build once is what makes those bytes the tested ones.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment records that reference tags instead of digests.",
      "Staging and production image digests that differ for the same release.",
      "Registry retention warnings or a missing previous digest during rollback.",
      "Admission-controller decisions that allow an unapproved digest.",
      "Provenance attestations that are absent, unsigned, or point at an unexpected builder.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the running digest in each environment, not the tag. Check whether the deploy job rebuilds after approval, whether admission verifies the digest, whether the previous digest still exists, and whether provenance connects the digest to the expected commit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop rebuilding per environment; make CI produce one artifact per commit.",
      "Deploy by digest and reject unapproved digests at admission.",
      "Attach signed provenance and retain it with the release record.",
      "Retain the previous production digest for the rollback and audit window.",
      "Test a rollback to the previous digest before the next release.",
      "Alert when the running digest differs from the approved digest.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "One artifact per commit simplifies identity but requires configuration to be injected outside the image.",
      "Long retention makes rollback reliable but increases registry storage and the number of artifacts to scan.",
      "Digest pinning is precise but makes routine base-image updates a deliberate promotion rather than a rebuild.",
      "Signed provenance adds supply-chain assurance but requires build-system identity and key management.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "different-build",
    question:
      "Staging passed, production runs the same commit, and production fails. How do you determine whether the artifact is the same?",
    difficulty: 2,
    hints: [
      "A tag is not an identity.",
      "Compare the actual content hash.",
      "Check whether production ran a build step.",
    ],
    answer:
      "I would compare the running image or package digest in staging and production. If they differ, I would inspect the promotion job to see whether it rebuilt after the gate, whether it resolved a mutable tag, or whether admission failed to check the digest. I would also check provenance for the source commit and builder. Until the digests match, I cannot attribute the difference to production configuration or traffic.",
    followUps: [
      "What would you change in the deployment spec?",
      "How do you prove the digest was approved?",
      "What if the digest is identical but the behavior still differs?",
    ],
    redFlags: ["Compares tags only.", "Assumes the same commit means the same binary.", "Skips the promotion job."],
    rubric: ["Compares digests.", "Inspects rebuild or tag mutation.", "Uses provenance.", "Separates artifact from config."],
  },
  {
    id: "promotion-design",
    question: "Design the promotion path for a container image from CI to production.",
    difficulty: 3,
    hints: [
      "Build once, then move the reference.",
      "Decide who approves the digest.",
      "Keep rollback in the design.",
    ],
    answer:
      "CI builds once and pushes an image by digest, then generates provenance and runs tests against that digest. The promotion record names the digest and the gate results. Staging deploys the digest; production promotion deploys the same digest with environment configuration injected separately. Admission verifies the digest is on the approved list. The previous production digest stays retained, and rollback references it directly. I would audit every deployment by digest and alert on drift.",
    followUps: [
      "Where should the environment configuration live?",
      "How long do you retain the previous digest?",
      "What do you do when the registry is unavailable during rollback?",
    ],
    redFlags: ["Promotes a tag.", "Rebuilds in production.", "Has no rollback artifact."],
    rubric: ["Names digest identity.", "Separates config.", "Defines approval.", "Plans retention and rollback."],
  },
  {
    id: "provenance",
    question: "What does provenance let you answer that a digest alone cannot?",
    difficulty: 2,
    hints: [
      "A digest proves content identity.",
      "Provenance records how the content was made.",
      "Investigation needs source and builder identity.",
    ],
    answer:
      "A digest proves that two artifacts are byte-identical, but not where they came from. Provenance records the source repository and commit, the builder identity, the build inputs, and the build parameters, usually in a signed attestation. That lets me trace an artifact back to a reviewed change, detect an unexpected builder, and reproduce or investigate a compromised build. It also supports policy such as requiring a protected branch and a trusted builder.",
    followUps: [
      "What would you verify before admitting an image?",
      "How do you handle a provenance record signed by an unknown builder?",
      "What is the limit of provenance for runtime behavior?",
    ],
    redFlags: ["Confuses provenance with vulnerability scanning.", "Trusts a tag.", "Cannot name source or builder."],
    rubric: ["Separates identity from origin.", "Names source, builder, inputs.", "Mentions verification.", "States limits."],
  },
  {
    id: "rollback-missing",
    question: "A rollback is needed, but the previous artifact was deleted. What are the options and their risks?",
    difficulty: 3,
    hints: [
      "Rebuilding is not restoring.",
      "The old schema and data may matter too.",
      "Prevention belongs in the release process.",
    ],
    answer:
      "The fast option is to rebuild from the recorded source commit and deploy that build, but it is not a true rollback: the rebuild can differ, and it has not passed the original promotion gate. I would treat it as an emergency release with review and verification. If the current version is failing, I might instead disable the faulty path with a flag or roll forward with a tested fix. After recovery, I would restore retention and test rollback artifacts before future releases.",
    followUps: [
      "What would you verify about the rebuilt artifact?",
      "When is roll-forward safer than a rebuild?",
      "How does data written by the new version change the decision?",
    ],
    redFlags: ["Treats a rebuild as identical.", "Skips verification.", "Ignores data compatibility."],
    rubric: ["States rebuild risk.", "Names alternatives.", "Verifies the emergency path.", "Fixes retention."],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Confirm CI builds once and publishes the artifact by digest.",
      "Require signed provenance and verify it before promotion.",
      "Confirm admission rejects unapproved digests.",
      "Retain the previous production digest for the rollback window.",
      "Test a rollback to the previous digest in a non-production environment.",
    ],
  },
  {
    title: "During the release",
    items: [
      "Deploy the approved digest; do not run a build step in the environment.",
      "Compare the running digest with the approval record.",
      "Check that environment configuration is injected, not baked into the image.",
      "Watch for tag mutations and unexpected artifact variants.",
    ],
  },
  {
    title: "After the release",
    items: [
      "Record the digest and provenance with the release outcome.",
      "Confirm the previous digest remains available until the rollback window closes.",
      "Audit any deploy that bypassed digest verification.",
      "Add any rebuilt artifact to the next release review.",
    ],
  },
];

const references = [
  {
    title: "SLSA provenance",
    url: "https://slsa.dev/spec/v1.0/provenance",
    publisher: "Open Source Security Foundation",
    kind: "standard" as const,
    note: "Attestation format linking an artifact digest to source, builder, and build inputs.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Build once, reproducible builds, and artifact promotion across environments.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "artifact-flow": {
      model: immutableArtifactsModel,
      presets,
      instructions:
        "Start with Healthy, then apply Rebuilt production and compare staging with production. Apply Rebuild only to isolate identity from verification. Use Recovery to see the retained rollback path, then run the experiment.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Divergence, verification coverage, retention, and lookup times are teaching values, not registry guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-build-once", "deployment-artifact-promotion", "deployment-cicd", "deployment-automated-rollback"],
};
