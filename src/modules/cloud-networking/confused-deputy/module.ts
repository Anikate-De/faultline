import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ROLE_ARN = "arn:aws:iam::111122223333:role/vendor-read";
const LEGIT_ASSUMES = 240;

const params = [
  {
    id: "trustMode",
    label: "Trust principal",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Trust",
    help: "0 trusts a third-party AWS account. 1 trusts an AWS service principal. The condition that proves the caller differs between them.",
    format: "count" as const,
  },
  {
    id: "externalId",
    label: "External ID required",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Trust",
    help: "1 adds sts:ExternalId to the trust policy. It binds a third-party account to this integration, not to every account that knows the role ARN.",
    format: "count" as const,
  },
  {
    id: "sourceAccount",
    label: "Source account pinned",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Trust",
    help: "1 adds aws:SourceAccount, the condition an AWS service uses to identify the account that owns the resource. It is not present on a direct cross-account assume.",
    format: "count" as const,
  },
  {
    id: "rogueAttempts",
    label: "Unintended assumes",
    min: 3,
    max: 60,
    step: 1,
    value: 8,
    unit: "/min",
    group: "Traffic",
    help: "AssumeRole calls per minute from an account that knows the role ARN but is not the intended caller.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  thirdParty: boolean;
  externalId: boolean;
  sourceAccount: boolean;
  wrongCondition: boolean;
  rogueAttempts: number;
  unauthorized: number;
  legitDenied: number;
  legitSuccess: number;
  roleHealth: Health;
  rogueHealth: Health;
}

function compute(p: Params): Computed {
  const thirdParty = num(p, "trustMode", 0) < 0.5;
  const externalId = num(p, "externalId", 1) >= 0.5;
  const sourceAccount = num(p, "sourceAccount", 0) >= 0.5;
  const rogueAttempts = Math.max(0, num(p, "rogueAttempts", 8));
  const blocked = thirdParty ? externalId : sourceAccount;
  const wrongCondition = thirdParty ? sourceAccount : externalId;
  const unauthorized = wrongCondition || blocked ? 0 : rogueAttempts;
  const legitDenied = wrongCondition ? 100 : 0;
  const legitSuccess = clamp(100 - legitDenied, 0, 100);
  const roleHealth: Health =
    unauthorized >= 1 || legitDenied >= 2 ? "crit" : unauthorized > 0 || legitDenied > 0 ? "warn" : "ok";
  return {
    thirdParty,
    externalId,
    sourceAccount,
    wrongCondition,
    rogueAttempts,
    unauthorized,
    legitDenied,
    legitSuccess,
    roleHealth,
    rogueHealth: unauthorized > 0 ? "crit" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["unauthorized-assumes", values.unauthorized, 0],
    ["legit-denied", values.legitDenied, 0],
    ["legit-assumes", LEGIT_ASSUMES, 4],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.6) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const principal = values.thirdParty ? "arn:aws:iam::999988887777:root" : "logs.amazonaws.com";
  const wrong = values.legitDenied > 0;
  return {
    t: 0,
    nodes: [
      {
        id: "tenant",
        label: "tenant-acme",
        kind: "client",
        health: wrong ? "crit" : "ok",
        sublabel: `intended caller · ${LEGIT_ASSUMES}/min`,
        detail: wrong
          ? "The intended caller cannot assume the role. The trust policy requires a condition key that this principal type does not send."
          : "The intended caller sends its assume request and receives temporary credentials for the role.",
        meta: { view: "flow" },
      },
      {
        id: "role",
        label: "vendor-read",
        kind: "mesh",
        health: values.roleHealth,
        sublabel: values.thirdParty ? "trust: third-party account" : "trust: AWS service",
        detail: `Trust policy principal ${principal}. ${
          values.thirdParty
            ? values.externalId
              ? "sts:ExternalId is required, so another account cannot assume the role by knowing its ARN."
              : "No ExternalId is required. Any account that knows the role ARN can assume it."
            : values.sourceAccount
              ? "aws:SourceAccount limits the service request to the intended account."
              : "No SourceAccount condition is present. Another account can create a service request that uses the role."
        }`,
        meta: { view: "flow", trustMode: values.thirdParty ? "third-party" : "service" },
      },
      {
        id: "rogue",
        label: "unintended account",
        kind: "external",
        health: values.rogueHealth,
        sublabel: `${formatCount(values.rogueAttempts)} assumes/min attempted`,
        detail:
          values.unauthorized > 0
            ? "The unintended caller knows the role ARN and the trust policy accepts it. The role now acts with the permissions of the intended tenant."
            : "The unintended caller knows the role ARN, but the trust condition rejects the assume request.",
        meta: { view: "flow", unauthorized: Math.round(values.unauthorized) },
      },
      {
        id: "bucket",
        label: "s3://tenant-acme-export",
        kind: "storage",
        health: "ok",
        sublabel: "tenant data boundary",
        detail:
          "The resource itself is healthy. A confused deputy is an authorization failure at the trust boundary, not a storage outage.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("tenant-role", "tenant", "role", wrong ? 0 : 1, wrong ? "crit" : "ok", "sts:AssumeRole"),
      edge("role-bucket", "role", "bucket", wrong ? 0 : 1, wrong ? "crit" : "ok"),
      edge(
        "rogue-role",
        "rogue",
        "role",
        values.rogueAttempts > 0 ? values.unauthorized / values.rogueAttempts : 0,
        values.unauthorized > 0 ? "crit" : "ok",
        "sts:AssumeRole",
      ),
    ],
    metrics: [
      metric("unauthorized-assumes", "Unauthorized assumes", values.unauthorized, "/min", 0.1, 1, "rps"),
      metric("legit-denied", "Intended caller denied", values.legitDenied, "%", 0.5, 2, "percent"),
      metric("legit-assumes", "Intended assumes", wrong ? 0 : LEGIT_ASSUMES, "/min", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.unauthorized)} unauthorized assumes/min; ${formatCount(
      wrong ? 0 : LEGIT_ASSUMES,
    )} intended assumes/min; ${values.thirdParty ? "third-party trust" : "service trust"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unauthorized-assumes",
    metricId: "unauthorized-assumes",
    warn: 0.1,
    crit: 1,
    title: "An unintended account is assuming the role",
    cause:
      "The trust policy accepts a principal that is not the intended caller. A role ARN is not a secret, so knowledge of the ARN is enough unless the policy binds the request to an external ID, source account, or source ARN.",
    fix:
      "Add the condition that matches the trust principal: sts:ExternalId for a third-party account, or aws:SourceAccount and aws:SourceArn for an AWS service. Remove the unintended principal and rotate any credentials issued to it.",
    checkFirst: [
      "Read the trust policy principal and every condition block.",
      "Compare the assumed-role session name and account in CloudTrail with the intended integration.",
      "Check the target resource for reads or writes made by the unexpected session.",
    ],
  },
  {
    id: "legit-denied",
    metricId: "legit-denied",
    warn: 0.5,
    crit: 2,
    title: "The trust condition denies the intended caller",
    cause:
      "The wrong condition key was applied to this principal type. A direct cross-account assume does not carry aws:SourceAccount, and an AWS service request does not carry an ExternalId unless the integration is built for it.",
    fix:
      "Match the condition to the principal: external ID for third-party accounts, source account and source ARN for AWS services. Test the assume call with the real principal before rollout.",
    checkFirst: [
      "Read the principal type in the trust policy.",
      "Compare the condition keys with the keys the caller actually sends.",
      "Test the assume call from the intended account or service.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const confusedDeputyModel: SimModel = {
  id: "cloud-networking-confused-deputy",
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
    const jitter = rng.between(-6, 6);
    next.metrics = next.metrics.map((item) =>
      item.id === "legit-assumes" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.unauthorized > 0 && frame.flags.rogueLogged !== 1) {
      pushEvent(next, {
        id: "unintended-assume",
        severity: "crit",
        title: "Unintended account assumed the role",
        detail: `${formatCount(values.unauthorized)} assume calls/min are coming from an account that knows ${ROLE_ARN}. The trust policy does not bind the caller to the intended integration.`,
        nodeId: "rogue",
        metricId: "unauthorized-assumes",
      });
    }
    next.flags.rogueLogged = values.unauthorized > 0 ? 1 : 0;
    if (values.legitDenied >= 2 && frame.flags.denyLogged !== 1) {
      pushEvent(next, {
        id: "trust-denies-intended",
        severity: "crit",
        title: "Trust policy denies the intended caller",
        detail:
          "The condition key does not apply to this principal type, so the integration cannot assume the role. The fix is a condition that matches the caller, not a broader principal.",
        nodeId: "tenant",
        metricId: "legit-denied",
      });
    }
    next.flags.denyLogged = values.legitDenied >= 2 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.unauthorized > 0) {
      items.push(
        `${formatCount(values.unauthorized)} unauthorized assumes/min succeed. The trust policy accepts the caller even though it is not the intended tenant. The role then acts with the tenant's permissions.`,
      );
    } else if (values.wrongCondition) {
      items.push(
        "No caller can assume the role. The condition key is absent for this principal type, so the trust policy denies the intended caller and the unintended caller alike.",
      );
    } else {
      items.push(
        "No unauthorized assume succeeds in this state. The trust condition binds the caller to the intended integration.",
      );
    }
    if (values.legitDenied > 0) {
      items.push(
        "The intended caller is denied. A condition was applied to the wrong principal type, which turns a security control into an availability incident.",
      );
    } else {
      items.push("The intended caller can assume the role and the resource path completes.");
    }
    items.push(
      values.thirdParty
        ? "A third-party trust should require sts:ExternalId. SourceAccount and SourceArn describe AWS service requests, not a direct cross-account assume."
        : "A service trust should require aws:SourceAccount and, where supported, aws:SourceArn. An ExternalId is not sent by the service.",
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
    description: "Third-party trust requires an external ID; only the intended tenant can assume the role.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Unintended assume attempts rise to 60/min; the external ID still rejects every one.",
    tone: "warn",
    params: defaults({ rogueAttempts: 60 }),
  },
  {
    id: "failure",
    label: "No external ID",
    description: "The trust policy accepts any account that knows the role ARN. An unintended account assumes it.",
    tone: "crit",
    params: defaults({ externalId: 0, rogueAttempts: 12 }),
  },
  {
    id: "wrong-condition",
    label: "Wrong condition",
    description: "A service role requires an ExternalId the service never sends; the intended caller is denied.",
    tone: "crit",
    params: defaults({ trustMode: 1, externalId: 1, sourceAccount: 0, rogueAttempts: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The external ID is restored and the unintended caller is rejected.",
    tone: "ok",
    params: defaults({ externalId: 1, rogueAttempts: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-external-id",
  title: "Bind the integration to the tenant",
  simId: "trust-path",
  question:
    "A third-party SaaS vendor assumes a role in your account to read one tenant's exports. The vendor uses the same role ARN for every customer. Which condition stops another customer from assuming it?",
  prediction: {
    options: [
      { id: "source-account", label: "aws:SourceAccount set to the vendor's account ID." },
      { id: "external-id", label: "sts:ExternalId set to a value unique to your integration." },
      { id: "role-name", label: "A less predictable role name." },
      { id: "source-arn", label: "aws:SourceArn set to the vendor's role ARN." },
    ],
    correctOptionId: "external-id",
    explanation:
      "For a third-party account, the caller controls its own account ID and role ARN, so those values do not distinguish one customer from another. An external ID is a value your service issues to the vendor and requires in the assume request. The vendor includes your ID for your tenant; another customer cannot assume your role without it.",
  },
  setup: defaults({ externalId: 0, rogueAttempts: 12 }),
  runFor: 12,
  observe: [
    "The unintended account assumes the role 12 times per minute.",
    "The intended tenant still succeeds, so delivery looks healthy on the tenant path.",
    "The unauthorized-assume metric is the only signal that the trust boundary failed.",
    "The role node is failing while the storage node stays healthy.",
  ],
  explain:
    "A role ARN identifies the role, not the caller. Anyone who can reach STS and knows the ARN can send an assume request. For a third-party integration, the external ID is the shared secret that binds the request to your tenant. Without it, the role becomes a confused deputy: it acts for whoever asks first.",
  fix: defaults({ externalId: 1, rogueAttempts: 12 }),
  debrief:
    "The fix is a condition on the trust policy, not a hidden role name. An external ID is designed for third-party integrations. For an AWS service principal, use aws:SourceAccount and aws:SourceArn instead. Test the assume call with the real principal before rollout, because the wrong condition denies the intended caller.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A confused deputy is a service that has permission to do something and is tricked into doing it for the wrong caller. In AWS, the common shape is an IAM role with a trust policy. The role ARN is an identifier, not a secret. If the trust policy accepts any account that knows the ARN, an unintended account can assume the role and use its permissions.",
  },
  {
    type: "p",
    text: "The defense is to bind the trust policy to the intended caller. For a third-party account, use an external ID: a value your service gives the vendor and requires on every assume request. For an AWS service principal, use aws:SourceAccount and, where supported, aws:SourceArn. Those keys describe the account and resource that caused the service to act. The right condition depends on the principal type.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is caller, sts:AssumeRole, trust policy, role session, target resource. The trust policy is evaluated before the role session exists. The identity policy on the role is evaluated later, when the session calls the target. That separation is why a broad trust policy cannot be fixed by tightening the role's identity policy.",
  },
  {
    type: "table",
    headers: ["Trust principal", "Weak policy", "Condition that binds it", "Failure if missing"],
    rows: [
      ["Third-party account", "Principal: arn:aws:iam::999988887777:root", "sts:ExternalId = tenant value", "Another customer assumes your role."],
      ["AWS service", "Principal: logs.amazonaws.com", "aws:SourceAccount and aws:SourceArn", "Another account creates a service request that uses the role."],
      ["Same account", "Principal: root", "aws:PrincipalArn or a specific role", "Any principal in the account can assume it."],
    ],
  },
  {
    type: "p",
    text: "The table is also a warning about copy-paste. An external ID on a service principal does nothing if the service does not send it, and a source account on a direct cross-account assume denies the intended caller. The condition has to match the principal and the request context.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unauthorized assumes per minute from an account that knows the role ARN.",
      "Intended-caller denials, which separate a security fix from an availability break.",
      "Trust principal mode: third-party account or AWS service.",
      "Role, tenant, unintended caller, and target resource as separate nodes.",
      "A prediction experiment that asks which condition binds a third-party integration.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that the unintended caller still attempts assumes; the condition rejects them. Apply No external ID and watch the unauthorized rate rise while the tenant path stays green. Then apply Wrong condition to see the opposite failure: the intended caller is denied because the condition key is not present. Run the experiment before revealing the answer.",
  },
  {
    type: "p",
    text: "The attempt rates and thresholds are illustrative. The trust-policy behavior, the principal types, and the condition keys are the parts to carry into production.",
  },
  { type: "sim", simId: "trust-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Without an external ID, the unintended account assumed the role at 12 attempts per minute. The tenant path stayed healthy, so a delivery dashboard would not have shown the breach. The only signal was the unauthorized-assume rate and the CloudTrail session from the wrong account.",
  },
  {
    type: "p",
    text: "The wrong-condition preset produced the opposite failure. The service principal did not send an ExternalId, so the trust policy denied the intended caller. The role was safe and useless at the same time. A condition that does not match the principal type is not a stronger control; it is an outage.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudTrail AssumeRole events: the account, principal ARN, session name, and whether the call succeeded.",
      "Trust policy history: the principal and condition block that were in effect at the time of the assume.",
      "Role session activity: the target resources touched by a session that should not exist.",
      "External ID configuration: the value your service issues and the value the vendor sends. A mismatch is an integration failure.",
      "Source account and source ARN on service principals: the values must match the resource owner, not the service's own account.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the trust policy principal and conditions before changing the role's identity policy. Then compare the CloudTrail assume event with the intended integration. If an unintended session exists, treat it as a credential exposure: identify what it read or wrote, revoke the session, and rotate any secrets it could reach.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the principal type: third-party account, AWS service, federated identity, or same-account role.",
      "For a third-party account, require sts:ExternalId with a value unique to the integration and rotate it only with the vendor.",
      "For an AWS service, require aws:SourceAccount and aws:SourceArn with the resource owner's values.",
      "Remove wildcard or root principals that are not required by the integration.",
      "Test the assume call with the real principal in a non-production account.",
      "Review CloudTrail for existing sessions from unexpected accounts and revoke them.",
      "Alert on successful assumes from accounts outside the approved list.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An external ID adds a coordination step with the vendor. Without it, the role is open to anyone who learns the ARN.",
      "Source account and source ARN conditions are precise for AWS services but do not apply to direct cross-account assumes.",
      "A unique role per tenant reduces the blast radius further, but it multiplies policy and onboarding work.",
      "Denying unknown principals is safer but can break a legitimate integration that has not been added to the condition yet.",
      "Auditing assumes is cheap; reconstructing what an unexpected session did after the fact is not.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-confused-deputy",
    question:
      "Explain a confused deputy in AWS IAM and why a hard-to-guess role ARN is not a fix.",
    difficulty: 3,
    hints: [
      "The role has permission; the caller supplies the identity.",
      "An ARN is an identifier, not an authentication factor.",
    ],
    answer:
      "A confused deputy is a privileged service or role that is tricked into acting for a caller it should not serve. In AWS, a role trust policy that accepts a broad principal lets any account that knows the role ARN assume it and use the role's permissions. The ARN is not a secret and can appear in logs, tickets, or another account's configuration. The fix is a condition that binds the request to the intended caller: an external ID for a third-party integration, or source account and source ARN for an AWS service. I would also review CloudTrail for existing sessions and alert on assumes from unexpected accounts.",
    followUps: [
      "When would you use an external ID instead of a source account?",
      "What does the role's identity policy control?",
      "How would you detect that the role was already misused?",
    ],
    redFlags: [
      "Says a long random role name is sufficient.",
      "Scopes the identity policy but leaves the trust policy open.",
      "Confuses authentication with authorization.",
    ],
    rubric: [
      "Defines the confused-deputy pattern.",
      "Explains why the ARN is not a secret.",
      "Chooses a condition that matches the principal.",
      "Includes detection and revocation.",
    ],
  },
  {
    id: "choose-condition",
    question:
      "A role is assumed by an AWS service to write logs into your account. Which trust conditions do you add, and why not an external ID?",
    difficulty: 3,
    hints: [
      "The service sends context keys about the resource that caused the call.",
      "The external ID is designed for third-party account integrations.",
    ],
    answer:
      "I would add aws:SourceAccount with the account that owns the log destination, and aws:SourceArn with the specific resource that should be allowed to write. Those keys are set by the AWS service on the request and bind the role to my resource. An external ID is for a third-party account that assumes the role directly; the service principal does not send it, so requiring one would deny the legitimate request. I would verify the supported condition keys for that service before deploying, then test the write path and check CloudTrail for the assumed-role session.",
    followUps: [
      "What if the service does not support aws:SourceArn?",
      "Which value belongs in SourceAccount: my account or the service's account?",
      "How would you test the trust policy without waiting for a production write?",
    ],
    redFlags: [
      "Uses an external ID for every trust policy.",
      "Pins the service's own account instead of the resource owner.",
      "Leaves the principal as a wildcard.",
    ],
    rubric: [
      "Chooses source account and source ARN.",
      "Explains why external ID is wrong here.",
      "Names the resource owner's account.",
      "Plans a verification step.",
    ],
  },
  {
    id: "condition-denies",
    question:
      "After adding a condition, the intended integration can no longer assume the role. What is your next step?",
    difficulty: 2,
    hints: [
      "Check the principal type first.",
      "The request context must contain the key.",
    ],
    answer:
      "I would read the trust policy principal and the condition key together. If the principal is a direct cross-account caller, aws:SourceAccount is not present, so the condition denies everything. If the principal is an AWS service, an ExternalId is not sent unless the integration is designed for it. I would compare the condition with the keys the caller actually sends, then choose the condition that matches the principal. I would test the assume call with the real principal and keep the previous trust policy available for rollback. If the integration is third-party, I would coordinate the external ID value with the vendor rather than removing the condition.",
    followUps: [
      "Which log shows the condition key that was missing?",
      "Would you roll back or fix forward?",
      "How do you prevent this in the next integration?",
    ],
    redFlags: [
      "Removes the condition to restore traffic.",
      "Widens the principal to root.",
      "Blames the vendor without reading CloudTrail.",
    ],
    rubric: [
      "Checks principal type and condition key.",
      "Explains why the key is absent.",
      "Restores the intended caller without removing protection.",
      "Tests with the real principal.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every cross-account role has an owner and a documented integration.",
      "Third-party trusts require an external ID unique to the integration.",
      "Service trusts require source account and source ARN where supported.",
      "Successful assumes from unexpected accounts create an alert.",
      "Role sessions are reviewed for least privilege and session duration.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the trust policy principal and conditions before editing the role policy.",
      "Compare CloudTrail assume events with the intended integration.",
      "Identify what the unexpected session read or wrote.",
      "Revoke the session and rotate reachable secrets.",
      "Restore the condition with the real principal and test the assume call.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the integration to the approved principal list.",
      "Document the external ID owner and rotation process.",
      "Add a test that the intended caller can assume and an unintended account cannot.",
      "Review other roles with broad trust policies.",
    ],
  },
];

const references = [
  {
    title: "The confused deputy problem",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains external ID, source account, and source ARN conditions for third-party and service principals.",
  },
  {
    title: "IAM condition element",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_condition.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines condition keys, operators, and how request context is evaluated.",
  },
  {
    title: "AWS global condition context keys",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Lists aws:SourceAccount, aws:SourceArn, and aws:PrincipalArn.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "trust-path": {
      model: confusedDeputyModel,
      presets,
      instructions:
        "Start healthy, then remove the external ID and watch unauthorized assumes. Compare that with the wrong-condition preset, which denies the intended caller.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Attempt rates and thresholds are teaching values; trust-policy evaluation is real.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-iam-roles",
    "cloud-networking-least-privilege",
    "cloud-networking-cross-account",
    "compliance-access-controls",
  ],
};
