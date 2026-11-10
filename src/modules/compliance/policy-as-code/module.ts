import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "preDeployCoverage",
    label: "Deploy paths with a policy gate",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Prevention",
    help: "Share of infrastructure and application deploy paths that evaluate policy before the change is applied. A path that can apply directly to the account is outside the gate.",
    format: "percent" as const,
  },
  {
    id: "policyCoverage",
    label: "Required controls encoded as policy",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Prevention",
    help: "Share of the required controls that exist as executable, tested policy: public storage, encryption, network exposure, privileged identity, and logging. A policy in a wiki is not encoded.",
    format: "percent" as const,
  },
  {
    id: "driftDetection",
    label: "Resources checked for drift",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Detection",
    help: "Share of deployed resources continuously evaluated against policy. Drift is a change that happened outside the pipeline or after the gate passed.",
    format: "percent" as const,
  },
  {
    id: "exceptionHygiene",
    label: "Exceptions scoped, owned, and expiring",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Exceptions",
    help: "Share of policy exceptions with a named owner, a scope, a reason, and an expiry. A permanent exception is an undocumented policy change.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  preDeploy: number;
  policy: number;
  drift: number;
  exception: number;
  bypass: number;
  policyGap: number;
  driftGap: number;
  exceptionGap: number;
  floor: number;
  exposure: number;
}

function compute(p: Params): Computed {
  const preDeploy = clamp(num(p, "preDeployCoverage", 100), 0, 100);
  const policy = clamp(num(p, "policyCoverage", 100), 0, 100);
  const drift = clamp(num(p, "driftDetection", 100), 0, 100);
  const exception = clamp(num(p, "exceptionHygiene", 100), 0, 100);
  const floor = Math.min(preDeploy, policy, drift, exception);
  return {
    preDeploy,
    policy,
    drift,
    exception,
    bypass: 100 - preDeploy,
    policyGap: 100 - policy,
    driftGap: 100 - drift,
    exceptionGap: 100 - exception,
    floor,
    exposure: 100 - floor,
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
  const pipelineHealth = healthFor(values.bypass, 5, 30);
  const policyHealth = healthFor(values.policyGap, 10, 40);
  const driftHealth = healthFor(values.driftGap, 15, 50);
  const exceptionHealth = healthFor(values.exceptionGap, 10, 40);
  const cloudHealth = healthFor(values.exposure, 15, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "repo",
        label: "Infrastructure code",
        kind: "storage",
        health: "ok",
        utilization: 0.5,
        sublabel: "declared intent",
        detail: "The repository that declares the desired state. A resource created in a console has no declaration here, which is why drift coverage is separate from the deploy gate.",
      },
      {
        id: "pipeline",
        label: "Deploy pipeline",
        kind: "worker",
        health: pipelineHealth,
        utilization: values.bypass / 100,
        sublabel: `${values.preDeploy.toFixed(0)}% of paths gated`,
        detail: "The path that plans and applies changes. If a path can bypass the policy step, the policy is advisory for that path.",
      },
      {
        id: "policy",
        label: "Policy engine",
        kind: "mesh",
        health: policyHealth,
        utilization: values.policyGap / 100,
        sublabel: `${values.policy.toFixed(0)}% of controls encoded`,
        detail: "Executable rules with tests, owners, and a stable decision output. A policy that is not tested can deny a valid change or allow the wrong one.",
      },
      {
        id: "cloud",
        label: "Production account",
        kind: "db",
        health: cloudHealth,
        utilization: values.exposure / 100,
        sublabel: `${values.floor.toFixed(0)}% control floor`,
        detail: "The running environment. The exposure is set by the weakest of the gate, the encoded controls, drift detection, and exception hygiene.",
      },
      {
        id: "drift",
        label: "Drift scanner",
        kind: "worker",
        health: driftHealth,
        utilization: values.driftGap / 100,
        sublabel: `${values.drift.toFixed(0)}% of resources checked`,
        detail: "The continuous evaluation that finds out-of-band changes, emergency edits, and resources the pipeline never owned.",
      },
      {
        id: "evidence",
        label: "Control evidence",
        kind: "storage",
        health: exceptionHealth,
        utilization: Math.max(values.exceptionGap, values.exposure) / 100,
        sublabel: `${values.exception.toFixed(0)}% of exceptions scoped and expiring`,
        detail: "The decision record: which policy ran, what it allowed or denied, which exception applied, and when the exception expires.",
      },
    ],
    edges: [
      edge("repo-pipeline", "repo", "pipeline", clamp(values.preDeploy / 100), pipelineHealth),
      edge("pipeline-policy", "pipeline", "policy", clamp(values.policy / 100), policyHealth),
      edge("policy-cloud", "policy", "cloud", clamp(1 - values.exposure / 100), cloudHealth),
      edge("cloud-drift", "cloud", "drift", clamp(values.drift / 100), driftHealth),
      edge("drift-policy", "drift", "policy", clamp(values.drift / 100), driftHealth),
      edge("policy-evidence", "policy", "evidence", clamp(values.exception / 100), exceptionHealth),
    ],
    metrics: [
      metric("deploy-bypass", "Deploy paths that bypass policy", values.bypass, "%", 5, 30, "percent"),
      metric("policy-gap", "Required controls not encoded", values.policyGap, "%", 10, 40, "percent"),
      metric("drift-gap", "Resources not checked for drift", values.driftGap, "%", 15, 50, "percent"),
      metric("exception-gap", "Exceptions without scope, owner, or expiry", values.exceptionGap, "%", 10, 40, "percent"),
      metric("control-floor", "Prevention and detection floor", values.floor, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.bypass.toFixed(0)}% of deploy paths bypass policy; ${values.policyGap.toFixed(0)}% of required controls are not encoded; ${values.driftGap.toFixed(0)}% of resources are unchecked for drift; ${values.exceptionGap.toFixed(0)}% of exceptions lack scope, owner, or expiry.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "deploy-bypass",
    metricId: "deploy-bypass",
    warn: 5,
    crit: 30,
    title: "A deploy path bypasses the policy gate",
    cause:
      "A policy that runs on one pipeline is not a control if another path can apply directly to the account. The bypass can be a manual deploy, a second pipeline, an emergency role, or an automation that was never wired into the gate. The resource is noncompliant before anyone reviews it.",
    fix:
      "Inventory every path that can change the production account and put the policy evaluation in each one. Deny the apply when the policy fails, make the bypass require a recorded break-glass approval, and test a direct apply to confirm it is blocked.",
    checkFirst: [
      "Which pipelines, roles, and humans can change the production account?",
      "Does every path evaluate policy before apply, or only some?",
      "Can an emergency role bypass the gate without a record?",
    ],
  },
  {
    id: "policy-gap",
    metricId: "policy-gap",
    warn: 10,
    crit: 40,
    title: "A required control is not encoded as policy",
    cause:
      "A written standard describes intent. An executable policy evaluates a specific resource attribute and returns a decision the pipeline can enforce. If the control is not encoded, every deploy depends on review attention, and the same mistake can pass repeatedly.",
    fix:
      "Convert each high-consequence control into a tested rule with an owner and a stable message. Start with public storage, encryption, network exposure, privileged identity, and logging. Keep the test fixtures next to the rule so a policy change cannot silently weaken the control.",
    checkFirst: [
      "Which required controls have no executable rule?",
      "Does each rule have a positive and negative test?",
      "Who owns the rule when the cloud API changes?",
    ],
  },
  {
    id: "drift-gap",
    metricId: "drift-gap",
    warn: 15,
    crit: 50,
    title: "Production can drift after the deploy passes",
    cause:
      "The pipeline is not the only way a resource changes. A console edit, an emergency fix, a different automation, or a provider-side default can make a compliant resource noncompliant after the gate. Prevention at deploy time cannot see a change that never deploys.",
    fix:
      "Continuously evaluate deployed resources against the same policy, record the expected and actual state, and route findings to an owner with a remediation deadline. Auto-remediate only the safe, reversible cases; require review for the rest.",
    checkFirst: [
      "Which resources are not covered by continuous evaluation?",
      "When was the last out-of-band change, and who made it?",
      "Does a finding have an owner and a remediation deadline?",
    ],
  },
  {
    id: "exception-gap",
    metricId: "exception-gap",
    warn: 10,
    crit: 40,
    title: "An exception has no scope, owner, or expiry",
    cause:
      "Exceptions are necessary for migrations and emergencies, but an exception without an owner and an expiry becomes a permanent policy change that nobody reviews. It also hides the control gap from the evidence, because the policy technically passed with an override.",
    fix:
      "Require every exception to name the resource scope, the reason, the owner, the compensating control, and the expiry. Review open exceptions before they expire, and remove the exception when the underlying condition is fixed.",
    checkFirst: [
      "Which exceptions are open, and when do they expire?",
      "Does each one name an owner and a compensating control?",
      "Is the exception scoped to a resource or applied to the whole account?",
    ],
  },
];

export const policyAsCodeModel: SimModel = {
  id: "compliance-policy-as-code",
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
    if (values.exposure >= 50 && frame.flags.exposureEvent !== 1) {
      const gaps = [
        { title: "A deploy path bypasses the policy gate", nodeId: "pipeline", metricId: "deploy-bypass", value: values.bypass },
        { title: "A required control is not encoded as policy", nodeId: "policy", metricId: "policy-gap", value: values.policyGap },
        { title: "Production can drift after the deploy passes", nodeId: "drift", metricId: "drift-gap", value: values.driftGap },
        { title: "An exception has no scope, owner, or expiry", nodeId: "evidence", metricId: "exception-gap", value: values.exceptionGap },
      ];
      const gap = gaps.reduce((best, item) => (item.value > best.value ? item : best));
      pushEvent(next, {
        id: "noncompliant-resource",
        at: frame.t,
        severity: "crit",
        title: gap.title,
        detail: `The control floor is ${values.floor.toFixed(0)}%, led by ${gap.metricId}. ${values.bypass.toFixed(0)}% of deploy paths bypass policy, ${values.policyGap.toFixed(0)}% of required controls are not encoded, ${values.driftGap.toFixed(0)}% of resources are unchecked for drift, and ${values.exceptionGap.toFixed(0)}% of exceptions lack scope, owner, or expiry.`,
        nodeId: gap.nodeId,
        metricId: gap.metricId,
      });
      next.flags.exposureEvent = 1;
    }
    if (values.exposure < 50) next.flags.exposureEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.bypass.toFixed(0)}% of deploy paths bypass policy; ${values.policyGap.toFixed(0)}% of required controls are not encoded; ${values.driftGap.toFixed(0)}% of resources are unchecked for drift; ${values.exceptionGap.toFixed(0)}% of exceptions lack scope, owner, or expiry.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The control floor is ${values.floor.toFixed(0)}%, set by the weakest of the deploy gate, encoded policy, drift detection, and exception hygiene. A perfect pipeline does not cover a console change.`,
      `${values.bypass.toFixed(0)}% of deploy paths bypass policy. Prevention only works when every path that can change the account is gated.`,
      `${values.policyGap.toFixed(0)}% of required controls are not encoded. A policy has to evaluate a concrete attribute and return a decision the pipeline can enforce; a wiki page cannot deny an apply.`,
      `${values.driftGap.toFixed(0)}% of resources are unchecked for drift. Continuous evaluation finds the changes that never went through the pipeline.`,
      `${values.exceptionGap.toFixed(0)}% of exceptions lack scope, owner, or expiry. An exception is a temporary, reviewed risk decision, not a silent policy change.`,
      "The percentages and the 5/30, 10/40, 15/50, and 10/40 thresholds are illustrative teaching values, not a fixed compliance standard.",
    ];
  },
  legend: [
    { label: "Enforced", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every deploy path is gated, the required controls are encoded and tested, drift is detected continuously, and exceptions expire.",
    tone: "ok",
    params: defaults({ preDeployCoverage: 100, policyCoverage: 100, driftDetection: 100, exceptionHygiene: 100 }),
  },
  {
    id: "peak",
    label: "Policy drift",
    description: "The pipeline is mostly gated and the rules are current, but a third of resources are not checked for drift and one control was weakened without a test.",
    tone: "warn",
    params: defaults({ preDeployCoverage: 95, policyCoverage: 90, driftDetection: 70, exceptionHygiene: 90 }),
  },
  {
    id: "failure",
    label: "Console bypass",
    description: "Most paths can bypass the gate, most controls are not encoded, drift is mostly unchecked, and exceptions have no owner or expiry.",
    tone: "crit",
    params: defaults({ preDeployCoverage: 10, policyCoverage: 30, driftDetection: 20, exceptionHygiene: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The gate covers every path, controls are encoded and tested, drift is continuously evaluated, and exceptions are scoped and expiring.",
    tone: "ok",
    params: defaults({ preDeployCoverage: 100, policyCoverage: 100, driftDetection: 100, exceptionHygiene: 100 }),
  },
  {
    id: "emergency-change",
    label: "Emergency exception",
    description: "An incident fix left a standing bypass and an exception with no owner or expiry. The exception is the largest gap, and the partial gate still lets a public resource persist.",
    tone: "crit",
    params: defaults({ preDeployCoverage: 40, policyCoverage: 90, driftDetection: 80, exceptionHygiene: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-drift",
  title: "Predict how the public bucket got through",
  simId: "policy-as-code",
  question:
    "The deploy pipeline has a tested policy that denies public buckets. A public bucket still appears in production. What is the most likely missing control?",
  prediction: {
    options: [
      { id: "rule", label: "The policy rule was never written" },
      { id: "drift", label: "The bucket changed outside the pipeline and there is no continuous drift detection" },
      { id: "encryption", label: "Encryption at rest was not enabled" },
      { id: "review", label: "The pull request did not have enough reviewers" },
    ],
    correctOptionId: "drift",
    explanation:
      "If the rule is tested and every pipeline path evaluates it, the remaining path is a change that did not go through the pipeline: a console edit, an emergency role, another automation, or a resource created before the gate. Prevention at deploy time cannot see those changes. Continuous evaluation is the missing control.",
  },
  setup: defaults({ preDeployCoverage: 100, policyCoverage: 100, driftDetection: 0, exceptionHygiene: 100 }),
  runFor: 20,
  observe: [
    "The drift gap is 100% and the drift scanner node fails.",
    "The control floor is 0% even though every deploy path is gated and every control is encoded.",
    "The production account is marked critical because an out-of-band change is invisible.",
    "Restoring drift detection clears the floor without changing the pipeline or the policy.",
  ],
  explain:
    "Policy as code has two moments: before apply and after apply. The deploy gate prevents a noncompliant declaration from being applied. Continuous evaluation detects a resource that changed later or never came from the pipeline. A program that only does the first is vulnerable to exactly the console change that produced the public bucket.",
  fix: defaults({ preDeployCoverage: 100, policyCoverage: 100, driftDetection: 100, exceptionHygiene: 100 }),
  debrief:
    "With drift detection restored, the same pipeline and policy now detect the out-of-band change and route it for remediation. The lesson is to cover both prevention and detection, and to keep the exception path reviewed. The percentages and thresholds are illustrative teaching values.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Policy as code turns a written control into an executable decision. Instead of a standard that says storage must not be public, a rule evaluates the resource attributes and returns allow or deny. The rule runs before a change is applied, and the same rule can evaluate deployed resources for drift. It has an owner, a test, a message, and a decision record.",
  },
  {
    type: "p",
    text: "The value is not the YAML or the Rego. It is the placement of the decision in the path. A policy that runs in a pull request but not in the apply path is advice. A policy that runs only at apply time cannot see a console edit or an emergency change. The control has to cover every path that can change the production account, and it has to keep checking after the deploy.",
  },
  {
    type: "p",
    text: "Exceptions are part of the design. A migration may need a temporary public bucket, a legacy role, or an unencrypted volume. If the exception has no scope, owner, compensating control, or expiry, it becomes a permanent policy change that nobody reviews. The policy engine should record the override so the evidence shows the risk decision rather than a clean pass.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The policy gate sits between the infrastructure code and the cloud account. The continuous scanner sits beside the running environment, evaluating the actual state. Evidence sits beside both, recording the rule version, the decision, the resource, and the exception. The same policy should produce the same decision in both places.",
  },
  {
    type: "table",
    headers: ["Layer", "What it prevents", "What it detects", "Evidence"],
    rows: [
      ["Pull request", "An obviously noncompliant declaration", "Review and policy result before merge", "Policy output and approval"],
      ["Deploy gate", "A noncompliant apply", "A blocked or allowed change", "Decision, rule version, resource"],
      ["Continuous scan", "Nothing by itself", "Drift and resources created outside the pipeline", "Expected versus actual state"],
      ["Exception", "An unmanaged permanent override", "Expiry and missing owner", "Scope, reason, owner, compensating control"],
    ],
  },
  {
    type: "p",
    text: "The tradeoff between prevention and detection is not a choice between them. Prevention stops the common path cheaply. Detection covers the paths prevention cannot see. A program that claims prevention while leaving a console path open has moved the failure, not removed it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Deploy paths that bypass policy: the share of change paths without a gate.",
      "Required controls not encoded: the gap between the written standard and executable rules.",
      "Resources not checked for drift: the share of production invisible to continuous evaluation.",
      "Exceptions without scope, owner, or expiry: the overrides that became permanent.",
      "Control floor: the weakest of prevention, encoded policy, drift detection, and exception hygiene.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Policy drift and Console bypass. Compare the deploy gate with the drift scanner and watch the control floor follow the weaker path. Run the experiment before revealing the explanation, then try Emergency bypass and apply Recovery.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The percentages and thresholds are illustrative teaching values. Policy content and evidence requirements come from the control framework, the contract, and the organization's risk decisions.",
  },
  {
    type: "p",
    text: "The useful question is not whether a policy exists. It is which change paths evaluate it, which resources are checked after the deploy, and who owns the exception when the rule cannot be satisfied yet.",
  },
  { type: "sim", simId: "policy-as-code" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The control floor fell to zero even though the pipeline was gated and the rule was tested. The public bucket arrived through a change that never passed the gate, and the drift scanner was not watching. In the emergency preset, a standing bypass and an unowned exception kept the floor low after the incident was over.",
  },
  {
    type: "p",
    text: "Restoring drift detection raised the floor without changing the pipeline or the rule. That is the lesson: prevention and detection cover different paths. The policy is only as strong as the weakest path that can change the account and the weakest exception that can override it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deploy: which pipelines, roles, and humans can apply to the production account.",
      "Policy: rule version, tests, deny message, owner, and last change.",
      "Drift: expected versus actual state, finding age, owner, and remediation deadline.",
      "Exceptions: scope, reason, compensating control, expiry, and approval.",
      "Evidence: the decision record for a blocked or allowed resource.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every path that can change the production account, including console and emergency roles.",
      "Confirm each path evaluates the policy before apply.",
      "Check which required controls have no executable rule or test.",
      "Review drift coverage for resources created outside the pipeline.",
      "List open exceptions and confirm each has an owner and an expiry.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Encode the highest-consequence controls first and keep positive and negative tests.",
      "Put the policy evaluation in every apply path and deny on failure.",
      "Add continuous evaluation for deployed resources and route findings to owners.",
      "Replace standing bypasses with a recorded break-glass path.",
      "Give every exception a scope, reason, owner, compensating control, and expiry.",
      "Test the control by attempting a noncompliant change through each path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Strict prevention reduces production risk but can block a legitimate change during an incident.",
      "Continuous scanning improves detection but adds cost, alert volume, and remediation work.",
      "Auto-remediation reduces response time but can make a bad policy change propagate quickly.",
      "Exceptions keep delivery moving but hide the gap until they expire or are reviewed.",
      "More policy coverage improves consistency but increases the maintenance burden when cloud APIs change.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "policy-placement",
    question: "Where should a policy gate run, and why is one location not enough?",
    difficulty: 2,
    hints: [
      "Think about every path that can change the account.",
      "Prevention and detection answer different questions.",
    ],
    answer:
      "The gate should run in every path that can apply a change to the production account, including the main pipeline, secondary pipelines, and any emergency role. That covers prevention. It is not enough because a console edit, another automation, or a resource created outside the pipeline can change the state after the gate. I would also run continuous evaluation against the same policy so drift is detected and routed for remediation.",
    followUps: [
      "How do you find a path you did not know about?",
      "What should happen when the gate itself is unavailable?",
      "How do you keep the policy consistent across both locations?",
    ],
    redFlags: [
      "Assumes the main pipeline is the only path.",
      "Treats prevention as complete coverage.",
      "Has no drift detection.",
    ],
    rubric: [
      "Covers every apply path.",
      "Separates prevention and detection.",
      "Uses the same policy.",
      "Plans for gate failure.",
    ],
  },
  {
    id: "prevent-detect",
    question: "When would you choose continuous detection over a blocking deploy gate?",
    difficulty: 3,
    hints: [
      "Blocking is not always possible or safe.",
      "Detection needs an owner and a deadline to be useful.",
    ],
    answer:
      "I would prefer prevention for high-consequence, well-understood controls such as public storage or missing encryption. Detection is the fallback when a change cannot be blocked safely, when the resource predates the gate, or when the control depends on runtime state that the deploy cannot see. Detection is only useful with an owner, a severity, and a remediation deadline; otherwise it becomes a dashboard nobody actions.",
    followUps: [
      "Which controls would you always block?",
      "How do you avoid alert fatigue?",
      "What would you auto-remediate?",
    ],
    redFlags: [
      "Chooses detection because blocking is hard.",
      "Has no remediation owner.",
      "Auto-remediates everything.",
    ],
    rubric: [
      "Blocks high-consequence controls.",
      "Uses detection for the uncovered paths.",
      "Assigns ownership and deadlines.",
      "Is careful with auto-remediation.",
    ],
  },
  {
    id: "exception",
    question: "How should a policy exception be designed?",
    difficulty: 2,
    hints: [
      "Temporary, scoped, owned, and reviewed.",
      "The exception should be evidence, not a silent pass.",
    ],
    answer:
      "An exception should name the resource or scope, the reason, the owner, the compensating control, and the expiry. It should be approved through a documented path and visible in the evidence, not applied as a global disable. I would review open exceptions before expiry and close them when the underlying condition is fixed. A permanent exception is a policy change and should go through the same review as the rule.",
    followUps: [
      "Who can approve an exception?",
      "What happens when it expires?",
      "How do you prevent exception sprawl?",
    ],
    redFlags: [
      "Uses a global allow list.",
      "Has no expiry.",
      "Hides the override from evidence.",
    ],
    rubric: [
      "Scopes the exception.",
      "Names owner and compensating control.",
      "Sets an expiry.",
      "Reviews and records it.",
    ],
  },
  {
    id: "emergency",
    question: "An incident requires a change that the policy blocks. How do you handle it without losing the control?",
    difficulty: 3,
    hints: [
      "Break-glass should be recorded and reviewed.",
      "The exception should not outlive the incident.",
    ],
    answer:
      "I would use a break-glass path with a named approver, a recorded reason, and the smallest possible scope. The change should still produce evidence and be reviewed after the incident. If the policy was wrong, I would fix the rule and its test; if the change was a genuine exception, I would give it an owner, a compensating control, and an expiry. Leaving the bypass in place after the incident is how a temporary fix becomes permanent exposure.",
    followUps: [
      "Who can invoke break-glass?",
      "How quickly should the review happen?",
      "What if the policy is blocking a legitimate emergency repeatedly?",
    ],
    redFlags: [
      "Disables the policy globally.",
      "Leaves the bypass open.",
      "Has no post-incident review.",
    ],
    rubric: [
      "Uses a scoped break-glass path.",
      "Records approval and evidence.",
      "Reviews after the incident.",
      "Fixes the rule or expires the exception.",
    ],
  },
];

const checklist = [
  {
    title: "Prevention",
    items: [
      "Inventory every path that can change the production account.",
      "Confirm each path evaluates policy before apply.",
      "Encode the highest-consequence controls and test both allow and deny.",
      "Replace standing bypasses with a recorded break-glass path.",
    ],
  },
  {
    title: "Detection",
    items: [
      "Continuously evaluate deployed resources against the same policy.",
      "Route findings to an owner with a remediation deadline.",
      "Check resources created outside the pipeline and before the gate.",
      "Record expected and actual state for the evidence.",
    ],
  },
  {
    title: "Exceptions",
    items: [
      "Require scope, reason, owner, compensating control, and expiry.",
      "Review open exceptions before they expire.",
      "Keep the exception visible in the evidence.",
      "Close the exception when the underlying condition is fixed.",
    ],
  },
];

const references = [
  {
    title: "Open Policy Agent documentation",
    url: "https://www.openpolicyagent.org/docs/latest/",
    publisher: "Open Policy Agent",
    kind: "docs" as const,
    note: "Policy language, decision model, and integration patterns for policy as code.",
  },
  {
    title: "AWS Config Developer Guide",
    url: "https://docs.aws.amazon.com/config/latest/developerguide/WhatIsConfig.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Resource configuration recording, compliance evaluation, and drift detection in AWS.",
  },
  {
    title: "NIST SP 800-53 Rev. 5, Configuration Settings (CM-6)",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Control requirements for establishing, documenting, and enforcing configuration settings.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "policy-as-code": {
      model: policyAsCodeModel,
      presets,
      instructions:
        "Start Healthy, then apply Policy drift and Console bypass. Compare the deploy gate with the drift scanner and watch the control floor follow the weaker path. Run the experiment before revealing the explanation, then try Emergency bypass and apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 5/30, 10/40, 15/50, and 10/40 thresholds are teaching values. Real policy content and evidence requirements come from the applicable control framework and risk decisions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-access-controls", "compliance-audit-logs", "compliance-evidence"],
};
