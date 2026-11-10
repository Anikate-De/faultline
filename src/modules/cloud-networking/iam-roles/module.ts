import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ROLE_SESSION_MINUTES = 60;
const STATIC_KEY_MINUTES = 43_200;

const params = [
  {
    id: "credentialMode",
    label: "Credential source",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Credential",
    help: "0 is a static access key in an environment variable, 1 is an instance profile role, 2 is a role assumed with an OpenID Connect (OIDC) web identity token.",
    format: "count" as const,
  },
  {
    id: "trustScope",
    label: "Trust policy scope",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Trust",
    help: "0 trusts the exact workload principal, 1 trusts any principal in the account, 2 trusts any AWS principal. The trust policy decides who may assume a role; it does not apply to a static access key.",
    format: "count" as const,
  },
  {
    id: "policyScope",
    label: "Permission policy scope",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Permissions",
    help: "0 grants only the actions and resources the workload needs, 1 grants administrator access. The permission policy decides what the session can do after it is assumed.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  credentialMode: number;
  trustScope: number;
  policyScope: number;
  staticKey: boolean;
  role: boolean;
  lifetime: number;
  blastRadius: number;
  exposedPaths: number;
  workloadSuccess: number;
  credentialLabel: string;
  trustLabel: string;
  policyLabel: string;
  workloadHealth: Health;
  credentialHealth: Health;
  stsHealth: Health;
  roleHealth: Health;
  dataHealth: Health;
  foreignHealth: Health;
}

function compute(p: Params): Computed {
  const credentialMode = Math.max(0, Math.min(2, Math.round(num(p, "credentialMode", 2))));
  const trustScope = Math.max(0, Math.min(2, Math.round(num(p, "trustScope", 0))));
  const policyScope = Math.max(0, Math.min(1, Math.round(num(p, "policyScope", 0))));
  const staticKey = credentialMode === 0;
  const role = credentialMode > 0;
  const trustRisk = !role ? 0 : trustScope === 0 ? 0 : trustScope === 1 ? 25 : 60;
  const policyRisk = policyScope === 1 ? 40 : 0;
  const staticRisk = staticKey ? 35 : 0;
  const blastRadius = clamp(trustRisk + policyRisk + staticRisk, 0, 100);
  const lifetime = staticKey ? STATIC_KEY_MINUTES : ROLE_SESSION_MINUTES;
  const exposedPaths =
    (staticKey ? 1 : 0) + (role && trustScope > 0 ? 1 : 0) + (policyScope === 1 ? 1 : 0);
  const credentialLabel = staticKey
    ? "static access key"
    : credentialMode === 1
      ? "instance profile role"
      : "OIDC web identity role";
  const trustLabel = !role
    ? "not applicable"
    : trustScope === 0
      ? "exact workload principal"
      : trustScope === 1
        ? "account wildcard"
        : "any AWS principal";
  const policyLabel = policyScope === 1 ? "administrator" : "scoped actions and resources";
  const roleHealth: Health = blastRadius >= 70 ? "crit" : blastRadius >= 35 ? "warn" : "ok";
  return {
    credentialMode,
    trustScope,
    policyScope,
    staticKey,
    role,
    lifetime,
    blastRadius,
    exposedPaths,
    workloadSuccess: 100,
    credentialLabel,
    trustLabel,
    policyLabel,
    workloadHealth: "ok",
    credentialHealth: staticKey ? "crit" : role && trustScope > 0 ? "warn" : "ok",
    stsHealth: role ? "ok" : "warn",
    roleHealth,
    dataHealth: policyScope === 1 ? "warn" : "ok",
    foreignHealth: !role ? "ok" : trustScope === 2 ? "crit" : trustScope === 1 ? "warn" : "ok",
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 3)) / 2.5));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "workload",
        label: "workload",
        kind: "service",
        health: v.workloadHealth,
        sublabel: `${v.credentialLabel}`,
        detail: `The workload makes AWS API calls. It succeeds in this model whether it uses a role or a static key; the difference is the credential's lifetime and the blast radius if it leaks.`,
        meta: { view: "flow" },
      },
      {
        id: "credential",
        label: "credential source",
        kind: "external",
        health: v.credentialHealth,
        sublabel: v.staticKey ? `key · ${v.lifetime / 1440} days` : "short-lived",
        detail: v.staticKey
          ? `A static access key is stored in an environment variable. It stays valid for ${v.lifetime / 1440} days in this model and does not expire when the workload stops.`
          : "The workload obtains temporary credentials from an instance profile or an OIDC token exchange. No long-lived secret is stored in the environment.",
        meta: { view: "flow" },
      },
      {
        id: "sts",
        label: "AWS STS",
        kind: "mesh",
        health: v.stsHealth,
        sublabel: v.role ? "AssumeRole / AssumeRoleWithWebIdentity" : "not used",
        detail: v.role
          ? `Security Token Service (STS) returns temporary credentials for a role session of ${ROLE_SESSION_MINUTES} minutes. The session inherits the role's permission policy.`
          : "A static key does not call STS. There is no session to expire, revoke centrally, or scope to a workload identity.",
        meta: { view: "flow" },
      },
      {
        id: "role",
        label: "IAM permissions",
        kind: "mesh",
        health: v.roleHealth,
        sublabel: v.role ? `trust: ${v.trustLabel}` : "no role used",
        detail: v.role
          ? `Trust policy: ${v.trustLabel}. Permission policy: ${v.policyLabel}. The trust policy decides who may assume the role; the permission policy decides what the session can do.`
          : `No role is used. The static key's IAM user or attached policy defines the permission scope (${v.policyLabel}); there is no trust policy to narrow.`,
        meta: { view: "flow" },
      },
      {
        id: "data",
        label: "AWS resources",
        kind: "storage",
        health: v.dataHealth,
        sublabel: v.policyScope === 1 ? "admin scope" : "scoped",
        detail:
          v.policyScope === 1
            ? "The session can call every action on every resource. A leaked session or key has the full blast radius of the account."
            : "The session can call only the actions and resources the workload needs. The blast radius is bounded by the policy.",
        meta: { view: "flow" },
      },
      {
        id: "foreign",
        label: "other principals",
        kind: "external",
        health: v.foreignHealth,
        sublabel:
          v.trustScope === 0 ? "not trusted" : v.trustScope === 1 ? "same account" : "any account",
        detail: !v.role
          ? "A static access key is not assumed through a trust policy, so this path does not apply. The key itself is the credential path."
          : v.trustScope === 0
            ? "Only the intended workload principal appears in the trust policy."
            : v.trustScope === 1
              ? "Any principal in the account that is allowed to call AssumeRole can use this role. The trust boundary is the account, not the workload."
              : "Any AWS principal that is allowed to call AssumeRole can use this role. The trust policy no longer identifies a caller.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("workload-credential", "workload", "credential", 1, v.credentialHealth),
      edge("credential-sts", "credential", "sts", v.role ? 1 : 0, v.stsHealth),
      edge("sts-role", "sts", "role", v.role ? 1 : 0, v.roleHealth),
      edge("role-data", "role", "data", v.role ? 1 : 0.5, v.dataHealth),
      edge("foreign-role", "foreign", "role", v.trustScope > 0 ? 1 : 0, v.foreignHealth),
    ],
    metrics: [
      metric("blast-radius", "Blast radius", v.blastRadius, "%", 35, 70, "percent"),
      metric("credential-lifetime", "Credential lifetime", v.lifetime, " min", 120, 1440, "number"),
      metric("exposed-paths", "Exposed credential paths", v.exposedPaths, "", 1, 2, "count"),
      metric(
        "workload-success",
        "Workload API success",
        v.workloadSuccess,
        "%",
        undefined,
        undefined,
        "percent",
      ),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${v.credentialLabel}; trust ${v.trustLabel}; policy ${v.policyLabel}; blast radius ${v.blastRadius}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blast-radius",
    metricId: "blast-radius",
    warn: 35,
    crit: 70,
    title: "A leaked credential would reach too far",
    cause:
      "The role is trusted too broadly, the permission policy is too wide, or the workload still uses a long-lived static key. The workload keeps working, so availability metrics do not show the exposure.",
    fix: "Narrow the trust policy to the exact principal, scope the permission policy to the required actions and resources, and replace static keys with a role.",
    checkFirst: [
      "Read the role's trust policy and identify every principal it allows.",
      "Read the permission policy and compare it with the actions the workload actually uses.",
      "Find long-lived access keys and their owners.",
    ],
  },
  {
    id: "credential-lifetime",
    metricId: "credential-lifetime",
    warn: 120,
    crit: 1440,
    title: "The credential outlives the workload",
    cause:
      "A static access key stays valid until someone rotates or deletes it. A role session expires, which limits how long a stolen credential is useful.",
    fix: "Move the workload to a role with a bounded session duration. Rotate or delete the static key after the cutover, and verify that no other consumer still uses it.",
    checkFirst: [
      "Find the credential source in the workload configuration, not only in the code.",
      "Check the access key's age and last-used date.",
      "Confirm the role session duration fits the workload.",
    ],
  },
  {
    id: "exposed-paths",
    metricId: "exposed-paths",
    title: "More than one exposure path exists",
    warn: 1,
    crit: 2,
    cause:
      "A static key, a broad trust policy, and an administrator permission policy are independent weaknesses. Fixing one does not remove the others.",
    fix: "Remove the static key, narrow the trust, and scope the permissions. Verify each change separately so a partial fix is visible.",
    checkFirst: [
      "List the credential paths that can reach the role or the account.",
      "Confirm the trust policy principal is the workload, not the account or a wildcard.",
      "Check whether the permission policy is broader than the observed calls.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const iamRolesModel: SimModel = {
  id: "cloud-networking-iam-roles",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.trustScope === 2 && frame.flags.wideTrustLogged !== 1) {
      pushEvent(next, {
        id: "iam-wide-trust",
        severity: "crit",
        title: "Trust policy allows any AWS principal",
        detail:
          "The role's trust policy no longer identifies a caller. Any principal that is allowed to call AssumeRole for this ARN can obtain the role's permissions.",
        nodeId: "foreign",
        metricId: "blast-radius",
      });
    }
    next.flags.wideTrustLogged = values.trustScope === 2 ? 1 : 0;
    if (values.staticKey && frame.flags.staticKeyLogged !== 1) {
      pushEvent(next, {
        id: "iam-static-key",
        severity: "crit",
        title: "Workload still uses a static access key",
        detail: `The key remains valid for ${STATIC_KEY_MINUTES / 1440} days in this model and does not expire with the workload. Replace it with a role before rotating it out.`,
        nodeId: "credential",
        metricId: "credential-lifetime",
      });
    }
    next.flags.staticKeyLogged = values.staticKey ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `${values.credentialLabel}; trust ${values.trustLabel}; policy ${values.policyLabel}; blast radius ${Math.round(values.blastRadius)}%.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    items.push(
      `Credential: ${v.credentialLabel}. Trust: ${v.trustLabel}. Permission: ${v.policyLabel}.`,
    );
    if (v.trustScope > 0) {
      items.push(
        "The trust policy is a resource-based permission, not an identity check for the workload. A wildcard principal means the caller is not identified by the role configuration.",
      );
    }
    if (v.staticKey) {
      items.push(
        `The static key is the exposure that survives a restart. A role session lasts ${ROLE_SESSION_MINUTES} minutes in this model and expires without a rotation job.`,
      );
    }
    if (v.policyScope === 1) {
      items.push(
        "Administrator access makes every other control less valuable. A leaked session or key can reach every resource the account can reach.",
      );
    }
    if (!v.staticKey && v.trustScope === 0 && v.policyScope === 0) {
      items.push(
        "This is the steady state: a short-lived role session, a trust policy that names the workload, and a permission policy that matches the calls.",
      );
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Broad", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "OIDC role, exact workload principal, scoped permissions, 60-minute session.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Account-wide trust",
    description: "An instance profile role with account-wide trust and scoped permissions.",
    tone: "warn",
    params: defaults({ credentialMode: 1, trustScope: 1, policyScope: 0 }),
  },
  {
    id: "failure",
    label: "Static key and admin access",
    description:
      "A long-lived access key with administrator access. No role or trust policy is involved.",
    tone: "crit",
    params: defaults({ credentialMode: 0, trustScope: 0, policyScope: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The workload returns to a short-lived OIDC role with exact trust and scoped access.",
    tone: "ok",
    params: defaults({ credentialMode: 2, trustScope: 0, policyScope: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-iam-wildcard-trust",
  title: "Predict what the wildcard trust allows",
  simId: "role-assumption",
  question:
    "A role's trust policy contains a wildcard AWS principal, and the role has administrator access. What is the main risk?",
  prediction: {
    options: [
      {
        id: "root-only",
        label: "Only the account root can assume the role, so the wildcard is harmless.",
      },
      {
        id: "any-principal",
        label:
          "Any principal that can call AssumeRole for the role ARN can obtain administrator credentials.",
      },
      {
        id: "trust-ignored",
        label: "The trust policy is ignored because the caller also needs an identity policy.",
      },
      { id: "no-keys", label: "The role is safe because it has no access key." },
    ],
    correctOptionId: "any-principal",
    explanation:
      "The trust policy is the resource-based permission that allows a principal to assume the role. A wildcard removes the principal constraint, so any caller that also has permission to call sts:AssumeRole for that ARN can obtain a session. Administrator access then gives that session the full account blast radius. Conditions and an exact principal restore the boundary.",
  },
  setup: defaults({ credentialMode: 2, trustScope: 2, policyScope: 1 }),
  runFor: 20,
  observe: [
    "Blast radius is 100% with wildcard trust and administrator access.",
    "Credential lifetime is 60 minutes; the exposure is the trust boundary, not key age.",
    "Two exposed credential paths are counted independently.",
    "The workload still reports 100% API success; availability metrics do not show the exposure.",
    "Narrowing only the trust or only the permissions leaves the other exposure.",
  ],
  explain:
    "A role is two policies. Trust decides who may assume it; permissions decide what the session can do. A wildcard trust with a broad permission policy is not a role problem, it is an account-wide delegation. The static-key failure preset shows the other path: a credential that outlives the workload.",
  fix: defaults({ credentialMode: 2, trustScope: 0, policyScope: 0 }),
  debrief:
    "The fix removes both paths at once: an exact workload principal and scoped permissions. The workload still succeeds. The static-key preset shows the separate fix for key age: replace the key with the role, then delete it and verify no other consumer depends on it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An AWS Identity and Access Management (IAM) role is an identity that a workload assumes instead of storing a password or access key. A role's access is defined by two kinds of policy. The trust policy names who may assume it. The permission policy names what the resulting session may do. Security Token Service (STS) issues temporary credentials for the session.",
  },
  {
    type: "p",
    text: "A workload can obtain the role through an instance profile on Amazon Elastic Compute Cloud (EC2), a task role in Amazon Elastic Container Service (ECS), a service account role in Amazon Elastic Kubernetes Service (EKS), or an OpenID Connect (OIDC) web identity token. In each case the workload exchanges a platform identity for a short-lived session.",
  },
  {
    type: "p",
    text: "A static access key is different. It is a long-lived secret that does not expire with the process and does not need STS. Replacing it with a role removes the secret from the environment, shortens the credential lifetime, and gives the account a single place to control access, though an issued session remains valid until it expires or is explicitly denied.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is workload, credential source, STS, role session, AWS API. The trust policy is evaluated when the session is created. The permission policy is evaluated on every API call. A failure in either one produces AccessDenied, but for different reasons.",
  },
  {
    type: "compare",
    leftTitle: "Trust policy",
    rightTitle: "Permission policy",
    rows: [
      { label: "Question", left: "Who may assume the role?", right: "What may the session do?" },
      { label: "Evaluated", left: "At AssumeRole time", right: "On each API call" },
      {
        label: "Typical mistake",
        left: "Wildcard principal",
        right: "Wildcard action and resource",
      },
      {
        label: "Fix",
        left: "Exact principal plus conditions",
        right: "Observed actions and scoped ARNs",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Credential source: static key, instance profile, or OIDC web identity.",
      "Trust scope: exact workload, account wildcard, or any AWS principal.",
      "Permission scope: scoped actions and resources, or administrator.",
      "Blast radius, credential lifetime, and the number of independent exposure paths.",
      "Workload API success, which stays at 100% while the security posture is failing.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and follow the session from the workload through STS to the role. Apply Account-wide trust and note that the workload still succeeds while the trust path warns. Then apply Static key and wildcard trust and read all three exposure paths before fixing one slider at a time.",
  },
  {
    type: "p",
    text: "The 60-minute session, 30-day static key, and blast-radius percentages are illustrative teaching values. Real session duration is bounded by the role's maximum session duration and the credential type. The scoring is a model, not a compliance measurement.",
  },
  { type: "sim", simId: "role-assumption" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the healthy state, the workload used an OIDC role. STS issued a 60-minute session, the trust policy named the workload, and the permission policy was scoped. The workload succeeded and the exposure paths were zero.",
  },
  {
    type: "p",
    text: "With account-wide trust, the workload still succeeded, but any principal in the account could assume the role. The workload metric did not change; only the trust path warned. That is the point: a working service can have a broken trust boundary.",
  },
  {
    type: "p",
    text: "In the failure preset, three weaknesses stacked: a static key, a wildcard principal, and administrator access. Blast radius reached 100% and the credential lifetime was 30 days. Fixing only the key would still leave a wildcard trust and admin permissions.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudTrail: AssumeRole and AssumeRoleWithWebIdentity events, including the calling principal and source identity.",
      "IAM: role trust policy, permission policy, maximum session duration, and last-used information for access keys.",
      "Credential reports: access key age, last used date, and whether the key belongs to a user or a workload.",
      "Workload configuration: environment variables, mounted secrets, instance profile, task role, or service account annotation.",
      "Access Analyzer: findings for resources shared with external principals and unused permissions.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the trust policy before the permission policy. A wildcard principal means the role can be assumed by a caller you did not intend. Then check the static keys and the permission scope. A green workload dashboard does not answer any of these questions.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the credential source in the workload configuration and confirm which role, profile, or key it uses.",
      "Replace the static key with a role: instance profile, task role, service account role, or OIDC trust.",
      "Narrow the trust policy to the exact principal and add conditions such as audience or source account where supported.",
      "Scope the permission policy to the actions and resources the workload actually calls.",
      "Deploy and verify the workload still succeeds with temporary credentials.",
      "Rotate or delete the static key, then check that no other consumer still uses it.",
      "Add a recurring review for trust policies, unused permissions, and access key age.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Roles remove long-lived secrets but add a dependency on STS and on the platform's identity plumbing. Cache the credentials and handle refresh failures explicitly.",
      "A short session limits exposure but may expire during a long batch. Size the duration to the workload and avoid extending it by default.",
      "An exact trust principal is safer but needs maintenance when the workload identity changes. A wildcard is easier and expands the blast radius.",
      "Administrator access is fast to grant and hard to justify. Scoped permissions take discovery work and break silently when the workload adds a call.",
      "Deleting a static key is the goal, but it is a distributed change. Find every consumer before revoking it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "role-vs-key",
    question:
      "A service uses an access key in an environment variable. What replaces it, and what changes for the application?",
    difficulty: 2,
    hints: [
      "The replacement is a role, not a smaller key.",
      "The application gets temporary credentials from the platform.",
    ],
    answer:
      "The key is replaced by an IAM role that the workload assumes through an instance profile, task role, service account role, or OIDC exchange. The application no longer reads a secret from the environment; the AWS SDK obtains temporary credentials from the platform and refreshes them. The role's trust policy names the workload identity, and the permission policy scopes what the session can do. After the cutover I would delete the key and check that no other consumer still uses it.",
    followUps: [
      "What changes in the SDK configuration?",
      "How do you prove the old key is unused?",
      "What is the failure mode when STS is unavailable?",
    ],
    redFlags: [
      "Creates a new access key instead.",
      "Puts the role ARN in an environment variable and assumes it with a key.",
      "Deletes the key before verifying the workload.",
    ],
    rubric: [
      "Names a role and a platform identity.",
      "Explains temporary credentials.",
      "Separates trust from permissions.",
      "Verifies and revokes the old key.",
    ],
  },
  {
    id: "trust-vs-permission",
    question:
      "A role has an exact trust policy and an administrator permission policy. What is the risk, and how do you reduce it?",
    difficulty: 2,
    hints: [
      "The trust policy limits who can assume the role.",
      "The permission policy limits what the session can do.",
    ],
    answer:
      "The trust boundary is narrow but the session can do anything in the account once assumed. The risk is a compromised workload, a leaked session token, or a mistaken call. I would reduce the permission policy to the actions and resources the workload actually uses, using observed access and Access Analyzer findings, then test in a non-production environment. I would keep the trust policy exact and add conditions where supported. The two policies are independent, so narrowing one does not fix the other.",
    followUps: [
      "How do you discover the real permissions?",
      "What would you test before deploying?",
      "Why not use a permission boundary?",
    ],
    redFlags: [
      "Thinks the trust policy limits permissions.",
      "Leaves admin access because the workload is internal.",
      "Scopes permissions without testing.",
    ],
    rubric: [
      "Separates trust from permissions.",
      "Uses observed access.",
      "Tests before deploying.",
      "Mentions boundaries or conditions.",
    ],
  },
  {
    id: "wildcard-trust",
    question:
      "Why is a wildcard principal in a role trust policy dangerous, even if the role has a scoped permission policy?",
    difficulty: 3,
    hints: [
      "The trust policy decides who can obtain the session.",
      "A scoped policy still grants whatever it allows.",
    ],
    answer:
      "A wildcard principal removes the identity constraint. Any caller that can invoke AssumeRole for the ARN can obtain a session, so the role is no longer tied to the intended workload. A scoped permission policy limits the damage but does not restore the boundary; the wrong principal can still use every permission in the policy. I would replace the wildcard with the exact principal, add conditions such as audience, source account, or source ARN, and review Access Analyzer findings for external access.",
    followUps: [
      "Which conditions would you add?",
      "How would you detect that the role was assumed by an unexpected principal?",
      "What if the workload identity is dynamic?",
    ],
    redFlags: [
      "Says the scoped policy makes it safe.",
      "Uses the account root as the principal.",
      "Ignores CloudTrail.",
    ],
    rubric: [
      "Explains the trust boundary.",
      "Distinguishes scope from identity.",
      "Adds conditions.",
      "Uses audit evidence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Workloads use roles, not static access keys, and the credential source is documented.",
      "Every role trust policy names an exact principal or a constrained identity provider.",
      "Permission policies are scoped to observed actions and resources.",
      "Access key age and last-used data are reviewed on a schedule.",
      "CloudTrail and Access Analyzer findings are routed to an owner.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the trust policy before the permission policy.",
      "Find the credential source and whether it is a key or a role session.",
      "Check CloudTrail for unexpected AssumeRole callers.",
      "Check the permission policy for the action that failed or succeeded unexpectedly.",
      "Revoke the credential at the source, not only in the application.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replace static keys with roles and delete the old keys.",
      "Narrow trust and permissions, then re-test the workload.",
      "Add conditions or permission boundaries where they reduce blast radius.",
      "Record the credential path and the exposure that was found.",
    ],
  },
];

const references = [
  {
    title: "IAM roles",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Roles, trust policies, temporary credentials, and the difference between a role and an IAM user.",
  },
  {
    title: "IAM role terms and concepts",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_terms-and-concepts.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Role session, trust policy, permissions policy, and the principals involved in assumption.",
  },
  {
    title: "IAM policy elements: Principal",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_principal.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How a principal is specified in a resource-based policy and what a wildcard means.",
  },
  {
    title: "AWS STS API reference",
    url: "https://docs.aws.amazon.com/STS/latest/APIReference/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AssumeRole, AssumeRoleWithWebIdentity, and the temporary credential model.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "role-assumption": {
      model: iamRolesModel,
      presets,
      instructions:
        "Start Healthy and follow the credential path. Apply Account-wide trust, then the static-key failure, and fix one exposure at a time. Watch the workload success metric stay green throughout.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Session duration, key age, and blast-radius percentages are teaching values, not compliance measurements.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-least-privilege",
    "cloud-networking-confused-deputy",
    "cloud-networking-secrets",
    "foundations-failure-domains",
  ],
};
