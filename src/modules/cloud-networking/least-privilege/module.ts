import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUIRED_ACTIONS = 24;
const DEFAULT_CALLS = 2_400;

const params = [
  {
    id: "granted",
    label: "Actions granted",
    min: 4,
    max: 40,
    step: 1,
    value: 24,
    unit: " actions",
    group: "Policy",
    help: "Number of actions in the policy. The workload needs 24; extra actions are unused grants, fewer actions deny part of the call mix.",
    format: "count" as const,
  },
  {
    id: "coverage",
    label: "Resource coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Policy",
    help: "Share of calls whose resource ARN matches the policy. A bucket ARN does not match an object ARN.",
    format: "percent" as const,
  },
  {
    id: "condition",
    label: "Condition match",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Policy",
    help: "Share of requests that satisfy every condition key, such as aws:SourceVpce or aws:PrincipalOrgID.",
    format: "percent" as const,
  },
  {
    id: "calls",
    label: "Offered calls",
    min: 100,
    max: 5_000,
    step: 100,
    value: DEFAULT_CALLS,
    unit: " calls/min",
    group: "Traffic",
    help: "Calls per minute from the workload. Denied calls are counted as a rate, not as throughput.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  granted: number;
  coverage: number;
  condition: number;
  calls: number;
  allowedFraction: number;
  allowedCalls: number;
  deniedCalls: number;
  deniedRate: number;
  unusedGrants: number;
  roleHealth: Health;
  appHealth: Health;
}

function compute(p: Params): Computed {
  const granted = Math.max(1, Math.round(num(p, "granted", REQUIRED_ACTIONS)));
  const coverage = clamp(num(p, "coverage", 100), 0, 100);
  const condition = clamp(num(p, "condition", 100), 0, 100);
  const calls = Math.max(1, num(p, "calls", DEFAULT_CALLS));
  const actionCoverage = Math.min(granted, REQUIRED_ACTIONS) / REQUIRED_ACTIONS;
  const allowedFraction = clamp(actionCoverage * (coverage / 100) * (condition / 100));
  const allowedCalls = calls * allowedFraction;
  const deniedCalls = calls - allowedCalls;
  const deniedRate = (1 - allowedFraction) * 100;
  const unusedGrants = Math.max(0, granted - REQUIRED_ACTIONS);
  const risk = deniedRate >= 2 || unusedGrants >= 8;
  const roleHealth: Health = risk ? "crit" : deniedRate >= 0.5 || unusedGrants >= 3 ? "warn" : "ok";
  return {
    granted,
    coverage,
    condition,
    calls,
    allowedFraction,
    allowedCalls,
    deniedCalls,
    deniedRate,
    unusedGrants,
    roleHealth,
    appHealth: deniedRate >= 2 ? "crit" : deniedRate >= 0.5 ? "warn" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["denied-rate", values.deniedRate, 0],
    ["unused-grants", values.unusedGrants, 0],
    ["allowed-calls", values.allowedCalls, 12],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.8) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const denied = values.deniedCalls > 0;
  const roleState =
    values.unusedGrants >= 8 ? "over-broad" : values.deniedRate >= 2 ? "deny" : "scoped";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "checkout-api",
        kind: "service",
        health: values.appHealth,
        sublabel: `${formatCount(values.calls)} calls/min`,
        detail:
          values.deniedRate >= 0.5
            ? `${formatCount(values.deniedCalls)} calls/min are denied. The application sees AccessDenied even though the SDK call is correct.`
            : "Every call completes. The role still has to be checked for permissions the workload does not use.",
        meta: { view: "flow" },
      },
      {
        id: "role",
        label: "task-role/checkout",
        kind: "mesh",
        health: values.roleHealth,
        sublabel: `${values.granted} actions · ${values.coverage}% resources`,
        detail:
          roleState === "over-broad"
            ? `The role allows ${values.granted} actions and ${100 - values.coverage}% of resources are wildcarded. Unused grants widen the blast radius without improving delivery.`
            : roleState === "deny"
              ? "The role is scoped, but the scope does not cover the full action, resource, or condition mix used by the workload."
              : "The role matches the observed action set and resource ARNs. Unused-grant pressure is low.",
        meta: { view: "flow", state: roleState },
      },
      {
        id: "policy",
        label: "policy/checkout-read",
        kind: "mesh",
        health: values.roleHealth,
        sublabel: `condition match ${Math.round(values.condition)}%`,
        detail:
          "The identity policy is evaluated with the resource policy and any permissions boundary. A matching Allow can still be overridden by an explicit Deny.",
        meta: { view: "flow", allowed: Math.round(values.allowedCalls) },
      },
      {
        id: "s3",
        label: "s3://reports-prod",
        kind: "storage",
        health: "ok",
        sublabel: `${formatPercent(values.allowedFraction * 100)}% of calls allowed`,
        detail:
          "The bucket is available. AccessDenied is an authorization result, not a storage outage. The S3 server access log or CloudTrail event names the denied action and ARN.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-role", "app", "role", values.allowedFraction, values.roleHealth === "crit" ? "crit" : "ok"),
      edge("role-policy", "role", "policy", values.allowedFraction, values.roleHealth),
      edge("policy-s3", "policy", "s3", values.allowedFraction, denied ? "warn" : "ok"),
    ],
    metrics: [
      metric("denied-rate", "Denied calls", values.deniedRate, "%", 0.5, 2, "percent"),
      metric("unused-grants", "Unused grants", values.unusedGrants, " grants", 3, 8, "count"),
      metric("allowed-calls", "Allowed calls", values.allowedCalls, " calls/min", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.calls)} calls/min offered; ${formatPercent(values.deniedRate)}% denied; ${
      values.unusedGrants
    } unused grant${values.unusedGrants === 1 ? "" : "s"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "denied-rate",
    metricId: "denied-rate",
    warn: 0.5,
    crit: 2,
    title: "A scoped policy is denying a production call",
    cause:
      "The policy no longer covers the action, resource ARN, or condition context used by the workload. A tightened policy fails closed, so the application reports an authorization error rather than a network timeout.",
    fix:
      "Compare the denied action and resource with CloudTrail and IAM Access Analyzer findings, restore the missing grant, and re-test in a non-production environment before widening the policy.",
    checkFirst: [
      "Read the CloudTrail errorCode and the denied action, resource ARN, and condition keys.",
      "Check for an explicit Deny, permissions boundary, or service control policy above the role.",
      "Confirm the resource ARN matches the object, not just the bucket or queue.",
    ],
  },
  {
    id: "unused-grants",
    metricId: "unused-grants",
    warn: 3,
    crit: 8,
    title: "The role still grants permissions no caller uses",
    cause:
      "Broad actions, wildcard resources, or permissions for retired features remain in the policy. Unused grants do not improve delivery, and they widen the blast radius if the role is compromised.",
    fix:
      "Remove unused actions, scope resources to exact ARNs, add conditions where they match the access path, and run the workload again before deleting the old policy version.",
    checkFirst: [
      "Compare the granted action list with the actions observed in CloudTrail over a full business cycle.",
      "Find wildcard resources and replace them with the ARNs the workload actually touches.",
      "Check whether a condition is present but never satisfied; an unused condition is not protection.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const leastPrivilegeModel: SimModel = {
  id: "cloud-networking-least-privilege",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    const jitter = rng.between(-8, 8);
    next.metrics = next.metrics.map((item) =>
      item.id === "allowed-calls" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.deniedRate >= 2 && frame.flags.denyLogged !== 1) {
      pushEvent(next, {
        id: "policy-deny",
        severity: "crit",
        title: "Production call denied by policy",
        detail: `${formatCount(values.deniedCalls)} calls/min are denied at ${formatPercent(values.deniedRate)}%. The role is too narrow for the observed action, resource, or condition mix.`,
        nodeId: "policy",
        metricId: "denied-rate",
      });
    }
    next.flags.denyLogged = values.deniedRate >= 2 ? 1 : 0;
    if (values.unusedGrants >= 8 && frame.flags.broadLogged !== 1) {
      pushEvent(next, {
        id: "unused-grants",
        severity: "warn",
        title: "Role retains unused permissions",
        detail: `${values.unusedGrants} unused grants remain. The role delivers traffic but gives an attacker more actions than the workload needs.`,
        nodeId: "role",
        metricId: "unused-grants",
      });
    }
    next.flags.broadLogged = values.unusedGrants >= 8 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.deniedRate >= 2) {
      items.push(
        `${formatPercent(values.deniedRate)}% of calls are denied. The application is healthy at the network layer; the role or policy no longer matches the action, resource, or condition the call uses.`,
      );
    } else if (values.deniedRate > 0) {
      items.push(
        `${formatPercent(values.deniedRate)}% of calls are denied, which is below the incident line but still a real gap. A partial ARN or condition match fails only the calls that take that path.`,
      );
    } else {
      items.push(
        `All ${formatCount(values.calls)} calls/min are allowed. Delivery alone does not prove least privilege; the unused-grant count is the second half of the check.`,
      );
    }
    if (values.unusedGrants > 0) {
      items.push(
        `${values.unusedGrants} unused grants remain. Extra actions and wildcard resources do not change delivery, but they change what a compromised role can reach.`,
      );
    } else {
      items.push(
        "No unused grants are counted in this state. The policy covers the required action set without wildcard resource scope.",
      );
    }
    items.push(
      "An explicit Deny, a permissions boundary, a service control policy, or a resource policy can override an Allow. Check the full authorization path before editing the identity policy.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The role covers the 24 required actions with exact resource ARNs and matching conditions.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic reaches 5,000 calls/min; the scoped policy still allows every call.",
    tone: "warn",
    params: defaults({ calls: 5_000 }),
  },
  {
    id: "failure",
    label: "Over-tightened",
    description: "The policy covers only 16 actions and 80% of the condition context. Production calls are denied.",
    tone: "crit",
    params: defaults({ granted: 16, condition: 80, calls: 2_400 }),
  },
  {
    id: "over-broad",
    label: "Wildcard baseline",
    description: "The original broad role allows 40 actions. Delivery is fine; 16 unused grants keep the risk.",
    tone: "crit",
    params: defaults({ granted: 40, coverage: 100, calls: 2_400 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The missing actions and conditions are restored, and the policy is verified against the call mix.",
    tone: "ok",
    params: defaults({ granted: 24, coverage: 100, condition: 100, calls: 2_400 }),
  },
];

const experiment: Experiment = {
  id: "predict-resource-arn",
  title: "Predict the authorization result",
  simId: "policy-path",
  question:
    "The policy allows s3:GetObject on arn:aws:s3:::reports but not on arn:aws:s3:::reports/*. The role has no other S3 permissions. What happens when the app reads reports/2026/summary.csv?",
  prediction: {
    options: [
      { id: "allowed-bucket", label: "Allowed, because the bucket ARN covers every object in the bucket." },
      { id: "denied-object", label: "Denied, because s3:GetObject acts on an object ARN and the policy points at the bucket." },
      { id: "allowed-list", label: "Allowed, because s3:ListBucket is implied by the bucket ARN." },
      { id: "denied-kms", label: "Denied only if the KMS key policy is missing a grant." },
    ],
    correctOptionId: "denied-object",
    explanation:
      "The resource element is matched against the resource the action operates on. s3:GetObject operates on an object, so the policy needs arn:aws:s3:::reports/*. The bucket ARN alone is the resource for bucket-level actions such as s3:ListBucket. This is why an action can look allowed while the request is still denied.",
  },
  setup: defaults({ granted: 24, coverage: 50, condition: 100, calls: 2_400 }),
  runFor: 12,
  observe: [
    "Half of the calls are denied while the rest complete.",
    "The unused-grant count is zero: the policy is too narrow, not too broad.",
    "The denied calls are an authorization result, not a network failure.",
    "The policy node shows partial resource coverage.",
  ],
  explain:
    "A policy statement is a triple: action, resource, and condition. All three have to match the request. The action s3:GetObject was present, but the resource ARN addressed the bucket instead of the object. The request failed closed with AccessDenied. Reading only the action list would have missed the gap.",
  fix: defaults({ granted: 24, coverage: 100, condition: 100, calls: 2_400 }),
  debrief:
    "Resource scope is part of least privilege, not a detail added later. When a policy grants an action, check which resource type the action operates on and use the ARN shape that matches it. Verify the denied call with CloudTrail before widening every resource in the statement.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Least privilege is the practice of granting an identity only the actions, resources, and conditions it needs for the work it actually does. An AWS Identity and Access Management (IAM) policy is a set of statements. Each statement names actions, resources, and optional conditions, and ends in Allow or Deny. A request is authorized only when the full path agrees: identity policy, resource policy, permissions boundary, service control policy, and any session policy.",
  },
  {
    type: "p",
    text: "A broad role such as *:* is easy to write and hard to defend. The safe reduction starts from evidence, not from guesswork. CloudTrail records the actions and resources that were actually used. IAM Access Analyzer can generate a policy from that observed access, and policy simulation can test a candidate before it reaches production. The goal is not the smallest possible policy. The goal is a policy that covers the real call mix without unused reach.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The workload assumes a role and receives temporary credentials. Every SDK call is signed with those credentials and evaluated against the policy path before the target service acts. The target service may also apply a resource policy, such as a bucket policy or a KMS key policy. Authorization therefore sits between the application and the data, not in the network path.",
  },
  {
    type: "table",
    headers: ["Policy element", "Broad choice", "Scoped choice", "What changes"],
    rows: [
      ["Action", "s3:*", "s3:GetObject, s3:ListBucket", "Unused S3 operations disappear from the session."],
      ["Resource", "Resource: *", "arn:aws:s3:::reports/*", "A call for another bucket or object is denied."],
      ["Condition", "None", "aws:SourceVpce = vpce-0a1b", "Calls outside the approved endpoint path are denied."],
      ["Verification", "Deploy and watch", "Replay observed calls in a non-production role", "The gap is found before customers find it."],
    ],
  },
  {
    type: "p",
    text: "The table shows why an action-only review is incomplete. The call mix includes an action, a resource, and a context. Tightening one element can break a call that the other two still allow. The simulation keeps all three visible so a denial can be attributed to the right element.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Allowed and denied calls per minute, separated from the request rate.",
      "Unused grants: actions and wildcard resource scope that the workload does not need.",
      "Policy state: scoped, denying, or over-broad.",
      "The role, policy, and target bucket as separate nodes, so an authorization failure is not mistaken for a storage outage.",
      "A prediction experiment that isolates a resource ARN mismatch.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Over-tightened and read the policy node before changing a slider. The calls fail with an authorization result, not a timeout. Next apply Wildcard baseline and compare delivery with the unused-grant count: both states can deliver traffic while only one is acceptable. Run the experiment before revealing the explanation, then restore the scoped policy with Recovery.",
  },
  {
    type: "p",
    text: "This model uses 24 required actions, a 2,400 calls/min baseline, and teaching thresholds. They are illustrative values, not IAM quotas. The policy semantics, the action-resource-condition triple, and the fail-closed behavior are the parts to carry into production.",
  },
  { type: "sim", simId: "policy-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The over-tightened policy denied roughly half of the calls while the network and the bucket stayed healthy. The missing action coverage and the condition mismatch each removed part of the call mix. The application reported AccessDenied, which is a different failure from a timeout, a 5xx, or a connection reset.",
  },
  {
    type: "p",
    text: "The wildcard baseline told the opposite story. Delivery was complete, but 19 unused grants remained. A role that can do more than the workload needs is not a delivery problem until it is compromised. Then it becomes a blast-radius problem, and the policy that looked harmless becomes the incident.",
  },
  {
    type: "p",
    text: "The resource ARN experiment added the third signal. The action was allowed, the condition matched, and the call was still denied because the resource pointed at the bucket rather than the object. Reading the action list alone would have sent the fix in the wrong direction.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudTrail: AccessDenied events with the denied action, resource ARN, error code, and the identity that made the call.",
      "IAM Access Analyzer: findings for unused permissions, public access, and policies generated from observed activity.",
      "Service logs: 403 responses that are easy to mislabel as application bugs or expired credentials.",
      "Policy simulation: a candidate policy evaluated against recorded calls before deployment.",
      "Change history: the policy version and the deployment that introduced it. IAM changes are global and can take effect without a service deploy.",
      "Resource policies and KMS key policies: a matching identity Allow can still fail if the target resource policy or key policy does not grant access.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the denied action and resource ARN from CloudTrail. Then check whether an explicit Deny, permissions boundary, or service control policy overrides the Allow. Only then edit the identity policy. A policy change that widens every resource to fix one ARN mismatch gives back most of the least-privilege gain.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Collect observed actions and resource ARNs over a full business cycle, including batch jobs and rare admin paths.",
      "Group the calls into the smallest action set that covers them. Keep read and write separate when the workload allows it.",
      "Scope each action to the resource type it operates on. Use object ARNs for object actions and bucket ARNs for bucket actions.",
      "Add conditions that match the real access path, such as a VPC endpoint, an organization, or a requested region.",
      "Test the candidate policy in a non-production role with recorded or replayed traffic. Compare denials by action and resource.",
      "Deploy with a rollback path, watch AccessDenied rates, and keep the previous policy version available.",
      "Remove unused grants on a schedule and record the owner and the evidence for each exception.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Tighter policies reduce blast radius but increase the chance of blocking a rare path. Observed access and a staged rollout manage that risk.",
      "Conditions make a policy more precise but add a dependency on request context. A missing context key can deny a legitimate call.",
      "Wildcards are cheaper to maintain, especially across many buckets or queues. Exact ARNs are safer but need a process for new resources.",
      "Access Analyzer policy generation shortens the first draft, but it reflects past traffic. A new feature has no history, so it needs a deliberate review.",
      "Deleting an unused grant is a change with no delivery signal. Without a review cadence, it waits until an auditor or an incident forces it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "reduce-wildcard-role",
    question:
      "A task role has *:* and security wants it reduced this sprint. How do you find the permissions the service actually needs?",
    difficulty: 3,
    hints: [
      "Start from evidence, not from the policy text.",
      "A full business cycle includes batch and admin paths.",
    ],
    answer:
      "I would start with CloudTrail and IAM Access Analyzer. I would collect the actions and resource ARNs used by the role over a full business cycle, including scheduled jobs and rare operational paths, then generate a candidate policy from that activity. I would group actions by resource type and split read from write where possible. I would add conditions that match the access path, such as the VPC endpoint or organization. Before production, I would replay or test the candidate in a non-production role, compare denials, and deploy with a rollback path and an AccessDenied alarm. I would keep the old policy version until the new one has survived a peak.",
    followUps: [
      "What traffic would a one-week observation window miss?",
      "How do you handle a new feature with no history?",
      "Which conditions would you add first?",
    ],
    redFlags: [
      "Rewrites the policy from the action names in code only.",
      "Deletes the broad role in one step during business hours.",
      "Adds a wildcard resource to avoid another review.",
    ],
    rubric: [
      "Starts from observed access.",
      "Covers rare and scheduled paths.",
      "Scopes actions, resources, and conditions.",
      "Verifies before production and keeps rollback.",
    ],
  },
  {
    id: "allow-still-denied",
    question:
      "The identity policy allows s3:GetObject on the bucket, but the call returns AccessDenied. What do you check?",
    difficulty: 3,
    hints: [
      "The resource element is matched against the resource the action operates on.",
      "An explicit Deny can override an Allow.",
    ],
    answer:
      "I would read the CloudTrail event for the denied action, resource ARN, and error code first. The most common cause is a resource mismatch: s3:GetObject acts on an object, so the policy needs arn:aws:s3:::bucket/*, not the bucket ARN. I would also check for an explicit Deny in the identity policy, a permissions boundary, a service control policy, or a session policy. If the object is encrypted with a KMS key, the key policy and the caller's kms:Decrypt permission also have to allow the request. Finally I would confirm the call is using the role I think it is using, because a stale credential or a different task role produces the same error.",
    followUps: [
      "Which of those checks is fastest from the CloudTrail event?",
      "How would a bucket policy change the result?",
      "Why can a KMS key policy deny an otherwise allowed S3 call?",
    ],
    redFlags: [
      "Widens the policy to Resource: * immediately.",
      "Assumes the bucket is down.",
      "Ignores explicit Deny and boundaries.",
    ],
    rubric: [
      "Reads the denied action and resource ARN.",
      "Explains object versus bucket ARN scope.",
      "Checks explicit Deny, boundaries, and SCPs.",
      "Considers KMS and resource policies.",
    ],
  },
  {
    id: "verify-before-production",
    question:
      "How do you verify a tighter policy without turning the change into a production incident?",
    difficulty: 3,
    hints: [
      "Recorded traffic is a test fixture.",
      "Watch denials, not only latency.",
    ],
    answer:
      "I would test the candidate policy in a non-production role with replayed or recorded traffic, then compare the denial set by action and resource. If a full replay is not available, I would deploy to one canary task or one non-critical account first, with an AccessDenied alarm and a fast rollback to the previous policy version. I would watch the denial rate by action and resource, not just the service error rate, because a denied background job may not affect the user-facing path immediately. I would also keep the old policy version and record which paths were not exercised so the gap is explicit.",
    followUps: [
      "What does a canary prove that policy simulation does not?",
      "Which alarm would you create?",
      "How long would you keep the old policy version?",
    ],
    redFlags: [
      "Relies on code review alone.",
      "Tests only the happy path.",
      "Has no rollback plan.",
    ],
    rubric: [
      "Uses recorded traffic or a canary.",
      "Measures denials by action and resource.",
      "Keeps rollback and records untested paths.",
      "Separates user-facing from background paths.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every long-lived role has an owner and a documented purpose.",
      "Observed access is collected over a full business cycle, including scheduled jobs.",
      "Policies separate read and write where the workload allows it.",
      "Resource ARNs are scoped to the resource type each action operates on.",
      "An AccessDenied alarm exists and is routed to the service owner.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the CloudTrail errorCode, action, and resource ARN before editing a policy.",
      "Check explicit Deny, permissions boundary, service control policy, and resource policy.",
      "Restore the smallest missing grant, not the original wildcard.",
      "Re-test the denied path in a non-production environment or a canary.",
      "Record the policy version and the rollback target.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test for the denied action and resource pair.",
      "Review whether the policy was too narrow or the code used the wrong ARN.",
      "Remove unused grants that the incident exposed.",
      "Update the observation window and the exception list.",
    ],
  },
];

const references = [
  {
    title: "Security best practices in IAM: Grant least privilege",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines least privilege and recommends starting with a minimum set of permissions.",
  },
  {
    title: "Generate policies based on access activity",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/access-analyzer-policy-generation.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "IAM Access Analyzer creates a policy from CloudTrail activity for review.",
  },
  {
    title: "IAM JSON policy elements: Resource",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains how the resource element is matched, including ARN shape.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "policy-path": {
      model: leastPrivilegeModel,
      presets,
      instructions:
        "Start healthy, then compare an over-tightened policy with a wildcard baseline. Read the denied-call rate and the unused-grant count together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 24-action set, call rate, and thresholds are teaching values, not IAM quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-iam-roles",
    "cloud-networking-confused-deputy",
    "cloud-networking-secrets",
    "compliance-access-controls",
  ],
};
