import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "verbBreadth",
    label: "Verb breadth",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Role",
    help: "0 is get. 1 adds list and watch. 2 adds create, update, and delete. 3 is the wildcard verb, which includes future verbs.",
    format: "count",
  },
  {
    id: "resourceBreadth",
    label: "Resource breadth",
    min: 0,
    max: 4,
    step: 1,
    value: 0,
    unit: "",
    group: "Role",
    help: "0 is configmaps. 1 adds pods, 2 adds deployments, 3 adds secrets, and 4 is the wildcard resource. Secrets are the escalation boundary in this model.",
    format: "count",
  },
  {
    id: "bindingScope",
    label: "Binding scope: namespace 0, cluster 1",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Binding",
    help: "0 binds the role in one namespace. 1 uses a ClusterRoleBinding, which applies the rule in every namespace.",
    format: "count",
  },
  {
    id: "tokenMount",
    label: "Automount service account token",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Workload",
    help: "1 mounts a token into the pod, so the workload can call the API with this identity. 0 removes the token when the workload does not need it.",
    format: "count",
  },
];

const verbTiers = [1, 3, 6, 12];
const resourceTiers = [1, 2, 3, 5, 12];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Values {
  verbBreadth: number;
  resourceBreadth: number;
  clusterScope: boolean;
  tokenMount: boolean;
  verbs: number;
  resources: number;
  allowedOps: number;
  secretScope: number;
  wildcard: boolean;
  privilege: number;
  namespaces: number;
}

function compute(p: Params): Values {
  const verbBreadth = Math.round(clamp(num(p, "verbBreadth", 0), 0, 3));
  const resourceBreadth = Math.round(clamp(num(p, "resourceBreadth", 0), 0, 4));
  const clusterScope = num(p, "bindingScope", 0) >= 1;
  const tokenMount = num(p, "tokenMount", 1) >= 1;
  const verbs = verbTiers[verbBreadth];
  const resources = resourceTiers[resourceBreadth];
  const allowedOps = verbs * resources;
  const secretAccess = resourceBreadth >= 3;
  const secretScope = secretAccess ? (clusterScope ? 2 : 1) : 0;
  const wildcard = verbBreadth >= 3 || resourceBreadth >= 4;
  const privilege = Math.round(
    clamp(
      (allowedOps / 144) * 60 +
        (clusterScope ? 20 : 0) +
        (tokenMount ? 8 : 0) +
        (secretScope === 1 ? 10 : 0) +
        (secretScope === 2 ? 12 : 0),
      0,
      100,
    ),
  );
  return {
    verbBreadth,
    resourceBreadth,
    clusterScope,
    tokenMount,
    verbs,
    resources,
    allowedOps,
    secretScope,
    wildcard,
    privilege,
    namespaces: clusterScope ? 12 : 1,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const privilegeHealth = healthFor(values.privilege, 20, 55);
  const secretHealth: Health = values.secretScope >= 2 ? "crit" : values.secretScope === 1 ? "warn" : "ok";
  const roleHealth: Health = values.wildcard ? "crit" : values.allowedOps >= 12 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "serviceaccount",
      label: "ServiceAccount",
      kind: "service",
      health: privilegeHealth,
      utilization: clamp(values.privilege / 100),
      sublabel: values.tokenMount ? "token mounted" : "no API token",
      detail:
        "The pod's identity. A mounted token lets any process in the container authenticate as this ServiceAccount; not mounting it removes that path when the workload does not call the API.",
      meta: { view: "flow" },
    },
    {
      id: "rolebinding",
      label: values.clusterScope ? "ClusterRoleBinding" : "RoleBinding",
      kind: "service",
      health: values.clusterScope ? "warn" : "ok",
      utilization: values.clusterScope ? 1 : 0.2,
      sublabel: `${values.namespaces} namespace${values.namespaces === 1 ? "" : "s"}`,
      detail: values.clusterScope
        ? "A ClusterRoleBinding grants the referenced role in every namespace. It is the right tool for cluster-wide controllers and the wrong default for a namespaced workload."
        : "A RoleBinding grants the role inside one namespace. The same role referenced by a different binding does not apply here.",
      meta: { view: "flow" },
    },
    {
      id: "role",
      label: values.wildcard ? "Wildcard role" : "Scoped role",
      kind: "service",
      health: roleHealth,
      utilization: clamp(values.allowedOps / 144),
      sublabel: `${values.verbs} verbs x ${values.resources} resources`,
      detail:
        "Role rules are allow rules. There is no deny rule to subtract from a grant; the only way to reduce access is to change or remove the binding or the rule.",
      meta: { view: "flow" },
    },
    {
      id: "apiserver",
      label: "kube-apiserver",
      kind: "service",
      health: "ok",
      utilization: clamp(values.allowedOps / 144),
      sublabel: "authorizes each request",
      detail:
        "The API server evaluates the request against the union of all bindings for the subject. Every matching allow rule contributes; a narrower rule does not cancel a broader one.",
      meta: { view: "flow" },
    },
    {
      id: "secrets",
      label: "Secrets",
      kind: "storage",
      health: secretHealth,
      utilization: values.secretScope / 2,
      sublabel:
        values.secretScope === 2
          ? "readable in every namespace"
          : values.secretScope === 1
            ? "readable in one namespace"
            : "not granted",
      detail:
        "Secrets are ordinary API objects for authorization. A role that can get or list them can read every Secret in its scope, including service account tokens and registry credentials.",
      meta: { view: "flow" },
    },
    {
      id: "workload",
      label: "Workload",
      kind: "service",
      health: privilegeHealth,
      utilization: clamp(values.privilege / 100),
      sublabel: `${values.allowedOps} allowed operation types`,
      detail:
        "The workload inherits the ServiceAccount's permissions. If the container is compromised, the attacker gets the same API access the application has.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("sa-binding", "serviceaccount", "rolebinding", 1, privilegeHealth, "bound by"),
      edge("binding-role", "rolebinding", "role", 1, roleHealth, "grants"),
      edge("role-api", "role", "apiserver", clamp(values.allowedOps / 144), roleHealth, "authorizes"),
      edge("api-secrets", "apiserver", "secrets", values.secretScope / 2, secretHealth, "reads"),
      edge("sa-workload", "serviceaccount", "workload", 1, privilegeHealth, "identity"),
    ],
    metrics: [
      metric("secret-scope", "Secret read scope", values.secretScope, "", 1, 2, "count"),
      metric("allowed-operations", "Allowed operation types", values.allowedOps, "", 12, 36, "count"),
      metric("privilege-score", "Privilege score", values.privilege, "", 20, 55, "number"),
      metric("namespaces-reached", "Namespaces in scope", values.namespaces, "", undefined, undefined, "count"),
      metric("wildcard-grant", "Wildcard grant", values.wildcard ? 1 : 0, "", 0.5, 0.5, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.allowedOps} allowed operation types across ${values.namespaces} namespace${
      values.namespaces === 1 ? "" : "s"
    }; Secrets ${values.secretScope === 2 ? "cluster-wide" : values.secretScope === 1 ? "namespaced" : "blocked"}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 7)) / 2.9);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "secret-scope",
    metricId: "secret-scope",
    warn: 1,
    crit: 2,
    title: "The workload can read Secrets in its scope",
    cause:
      "The role includes the secret resource. A RoleBinding limits that grant to one namespace; a ClusterRoleBinding applies it in every namespace. A wildcard resource rule includes secrets even when the author was thinking about ConfigMaps, and RBAC is additive: another narrow binding does not reduce this one.",
    fix:
      "Use a RoleBinding unless the workload genuinely needs every namespace. Replace the wildcard resource with the exact resource, and use resourceNames where the API supports it. Remove secrets from the rule if the workload only needs ConfigMaps.",
    checkFirst: [
      "Run kubectl auth can-i get secrets --as=system:serviceaccount:NS:SA and add --all-namespaces.",
      "List the ServiceAccount's RoleBindings and ClusterRoleBindings, then read the referenced rules.",
      "Check aggregated ClusterRoles and any controller that creates bindings automatically.",
    ],
  },
  {
    id: "allowed-operations",
    metricId: "allowed-operations",
    warn: 12,
    crit: 36,
    title: "The role grants far more operations than the workload uses",
    cause:
      "Wildcard verbs and resources multiply into a large allow set. The workload may only read one ConfigMap, but the role also permits creating, updating, and deleting many resource types. Future resource types are included automatically by a wildcard.",
    fix:
      "Enumerate the verbs and resources the workload actually calls. Start from the API audit log or a can-i probe, remove the rest, and re-test the workload. A role should be small enough to review line by line.",
    checkFirst: [
      "Compare the role's verbs and resources with the workload's API calls or audit log.",
      "Check for wildcard rules and for verbs the workload never uses.",
      "Check whether the role is reused by other subjects that need more access.",
    ],
  },
  {
    id: "privilege-score",
    metricId: "privilege-score",
    warn: 20,
    crit: 55,
    title: "The ServiceAccount has a broad blast radius",
    cause:
      "The score combines allowed operations, cluster scope, Secret access, and an automounted token. Any one of them is manageable; together they mean a compromised container can reach far beyond its own namespace.",
    fix:
      "Reduce the role to the minimum, bind it in one namespace, and disable token automount when the workload does not call the API. Use a distinct ServiceAccount per workload instead of the namespace default.",
    checkFirst: [
      "Check whether the pod uses a dedicated ServiceAccount or the default one.",
      "Check automountServiceAccountToken on the pod and the ServiceAccount.",
      "Check the union of all bindings, not just the one you expected.",
    ],
  },
];

export const rbacModel: SimModel = {
  id: "kubernetes-rbac",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.events = [...frame.events];
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "privilege-score"
        ? { ...item, value: Math.min(100, Math.max(0, item.value * jitter)) }
        : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed: Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt),
      paramsKey: JSON.stringify(p),
    };
    if (values.secretScope >= 2 && frame.flags.wildcardEvent !== 1) {
      pushEvent(next, {
        id: "cluster-secret-access",
        severity: "crit",
        title: "A ClusterRoleBinding exposes Secrets in every namespace",
        detail:
          "The bound rule includes the secret resource, and the binding is cluster-scoped. Every namespace is in scope, including namespaces this workload was never meant to touch.",
        nodeId: "secrets",
        metricId: "secret-scope",
      });
      next.flags.wildcardEvent = 1;
    }
    if (values.secretScope < 2) next.flags.wildcardEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines = [
      `The role allows ${values.allowedOps} operation types: ${values.verbs} verbs across ${values.resources} resource types.`,
      values.clusterScope
        ? `The ClusterRoleBinding applies in ${values.namespaces} namespaces. Namespace scope is a property of the binding, not of the role.`
        : "The RoleBinding applies in one namespace. The same ClusterRole can be reused elsewhere without granting access here.",
      values.secretScope === 2
        ? "Secrets are readable cluster-wide. This is the grant to remove first."
        : values.secretScope === 1
          ? "Secrets are readable in one namespace. That may still include tokens and registry credentials for every workload there."
          : "The role does not include secrets.",
      values.wildcard
        ? "A wildcard rule includes resource types and verbs that did not exist when the role was written."
        : "The rule is explicit, so a new resource type does not silently enter the allow set.",
    ];
    return lines;
  },
  legend: [
    { label: "Within the requested scope", tone: "ok" },
    { label: "Broader than needed", tone: "warn" },
    { label: "Secrets exposed cluster-wide", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A dedicated ServiceAccount can get one ConfigMap in its own namespace and does not need Secrets.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Namespaced Secret read",
    description: "The workload reads Secrets in its own namespace, a common convenience that widens the blast radius.",
    tone: "warn",
    params: defaults({ verbBreadth: 1, resourceBreadth: 3, bindingScope: 0, tokenMount: 1 }),
  },
  {
    id: "failure",
    label: "Wildcard cluster binding",
    description: "A wildcard ClusterRole is bound cluster-wide, so the workload can read every Secret in every namespace.",
    tone: "crit",
    params: defaults({ verbBreadth: 3, resourceBreadth: 4, bindingScope: 1, tokenMount: 1 }),
  },
  {
    id: "recovery",
    label: "Scoped least privilege",
    description: "One explicit get on one ConfigMap in one namespace, with no API token mounted.",
    tone: "ok",
    params: defaults({ verbBreadth: 0, resourceBreadth: 0, bindingScope: 0, tokenMount: 0 }),
  },
  {
    id: "wildcard-role",
    label: "Wildcard role, one namespace",
    description: "Namespace scope limits the damage, but the role still allows every verb on every resource, including Secrets.",
    tone: "crit",
    params: defaults({ verbBreadth: 3, resourceBreadth: 4, bindingScope: 0, tokenMount: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-wildcard-secret",
  title: "Predict what a wildcard ClusterRoleBinding grants",
  simId: "rbac",
  question:
    "A ServiceAccount is bound with a ClusterRoleBinding to a ClusterRole whose only rule is verbs: ['*'] and resources: ['*']. The workload only reads ConfigMaps. Can it read Secrets in every namespace?",
  prediction: {
    options: [
      { id: "no-use", label: "No. RBAC grants only the operations the workload actually uses" },
      { id: "yes-wildcard", label: "Yes. The wildcard rule includes Secrets and the binding is cluster-wide" },
      { id: "own-ns", label: "Only in its own namespace, because a ServiceAccount is namespaced" },
      { id: "token", label: "Only if the Secret is mounted as a volume" },
    ],
    correctOptionId: "yes-wildcard",
    explanation:
      "RBAC is additive and has no implicit deny. A wildcard resource rule includes the secret resource, and a ClusterRoleBinding applies that rule in every namespace. The ServiceAccount's namespace limits where the identity lives, not where a cluster-scoped binding applies. The workload's intent and its actual API calls do not reduce the grant.",
  },
  setup: defaults({ verbBreadth: 3, resourceBreadth: 4, bindingScope: 1, tokenMount: 1 }),
  runFor: 20,
  observe: [
    "Secret read scope is 2, meaning cluster-wide.",
    "Allowed operation types reach 144 in this model because both dimensions are wildcards.",
    "The Secrets node turns critical while the API server remains healthy.",
    "Removing the wildcard and using a namespaced RoleBinding brings the scope back to zero.",
  ],
  explain:
    "The authorization decision is the union of all allow rules for the subject. A ClusterRoleBinding is not a stronger RoleBinding; it is a different scope. Wildcards make the rule shorter to write and broader to review, because they include resources and verbs the author may not have considered.",
  fix: defaults({ verbBreadth: 0, resourceBreadth: 0, bindingScope: 0, tokenMount: 0 }),
  debrief:
    "The scoped fix grants one verb on one resource in one namespace and removes the token the workload did not need. The wildcard role was not wrong because it was cluster-scoped; it was wrong because the workload never needed the extra verbs, resources, or namespaces. Review the union of bindings, not the one you remember creating.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Kubernetes role-based access control, or RBAC, decides whether an API request is allowed. A request comes from a subject: a user, a group, or a ServiceAccount. A Role or ClusterRole holds allow rules made of verbs, resources, and optional resource names. A RoleBinding or ClusterRoleBinding attaches those rules to a subject. The API server checks the union of every binding for that subject and allows the request if any rule matches.",
  },
  {
    type: "p",
    text: "There is no deny rule. A narrow binding does not subtract from a broad one, and a missing rule is a denial only because nothing allowed it. This is why an audit starts with the subject and enumerates all bindings, including ones created by a controller or a chart. A ServiceAccount is namespaced, but a ClusterRoleBinding that references it applies in every namespace. The namespace of the identity and the scope of the grant are different things.",
  },
  {
    type: "p",
    text: "Pods authenticate with a projected service account token when automount is enabled. Any process in the container can use that token, so the workload's RBAC permissions are also the permissions of anyone who compromises the container. Disabling automount removes the credential path when the workload does not call the API.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it decides", "Common mistake"],
    rows: [
      ["ServiceAccount", "Which identity the pod uses", "Every pod in a namespace uses the default account"],
      ["Role or ClusterRole", "Which verbs and resources are allowed", "A wildcard rule includes Secrets and future resources"],
      ["RoleBinding", "Who gets the role in one namespace", "Assuming a role is global because it is a ClusterRole"],
      ["ClusterRoleBinding", "Who gets the role in every namespace", "Using it for a workload that only needs one namespace"],
      ["Token automount", "Whether the pod can call the API at all", "Leaving a token in a workload that never uses it"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 12-namespace cluster, tiered verb and resource counts, and a 0 to 100 privilege score as illustrative values. The score is a teaching aid, not a Kubernetes metric. The authorization behavior and the additive rule evaluation are the parts to carry into production.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Secret read scope: none, one namespace, or every namespace.",
      "Allowed operation types: the product of the granted verbs and resource types.",
      "Privilege score: the combined effect of breadth, scope, Secret access, and token mount.",
      "The binding node: whether the grant is namespaced or cluster-wide.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with one get on one ConfigMap. Raise the resource breadth to include Secrets and watch the scope become namespaced. Then switch to a ClusterRoleBinding and a wildcard role. Finish with Scoped least privilege and confirm every signal returns to zero.",
  },
  { type: "sim", simId: "rbac" },
  { type: "experiment", experimentId: "predict-wildcard-secret" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset combined a wildcard role with a ClusterRoleBinding. The API server did not evaluate the workload's intent; it evaluated the union of allow rules and found a match for Secrets in every namespace. The Secrets node and the privilege score moved together because they were computed from the same grant.",
  },
  {
    type: "p",
    text: "The recovery preset kept the identity but reduced the rule to one verb on one resource and removed the token. The same application code worked because it only used the one call it needed. The namespaced preset showed the middle case: Secrets were readable, but only where the RoleBinding applied.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl auth can-i output for the exact ServiceAccount, verb, resource, and namespace.",
      "The ServiceAccount's RoleBindings and ClusterRoleBindings, including subjects that match a group.",
      "Role rules with wildcards, and aggregated ClusterRoles that add rules from labels.",
      "API server audit logs for the subject, especially get and list on secrets.",
      "The pod spec's serviceAccountName and automountServiceAccountToken fields.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Start from the ServiceAccount and list every binding that references it. Read the referenced rules, then test the exact request with kubectl auth can-i. A role you did not create, or a ClusterRoleBinding added by a chart, is a common source of access you did not intend.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the ServiceAccount the workload actually uses.",
      "Enumerate all RoleBindings and ClusterRoleBindings for that subject.",
      "Replace wildcard verbs and resources with the exact calls the workload makes.",
      "Use a RoleBinding unless the workload genuinely operates across namespaces.",
      "Disable token automount when the workload does not call the API.",
      "Re-test with kubectl auth can-i and confirm the workload still functions.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Narrow roles are safer and require maintenance when the workload adds an API call.",
      "Wildcard roles are convenient and make every future resource type part of the grant.",
      "A ClusterRoleBinding is necessary for cluster-wide controllers and excessive for a namespaced service.",
      "Disabling automount improves isolation and breaks any workload that quietly relies on the token.",
      "A shared ServiceAccount reduces object count and merges the blast radius of every workload that uses it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-the-binding",
    question:
      "A pod can read Secrets in its namespace, but the team says its Role only grants ConfigMap access. How do you find what allowed it?",
    difficulty: 2,
    hints: [
      "Start from the ServiceAccount, not the Role you expect.",
      "There can be more than one binding.",
    ],
    answer:
      "I would identify the ServiceAccount in the pod spec and list every RoleBinding and ClusterRoleBinding that references it, including bindings to groups the ServiceAccount belongs to. Then I would read each referenced role and look for secrets in the resource list, including wildcards and aggregated ClusterRoles. I would confirm the exact request with kubectl auth can-i get secrets --as=system:serviceaccount:NS:SA. If the answer is still surprising, the audit log shows which request succeeded and under which identity.",
    followUps: [
      "How do aggregated ClusterRoles change the answer?",
      "What does a wildcard resource include?",
      "Why does a RoleBinding to a ClusterRole not grant cluster-wide access?",
    ],
    redFlags: [
      "Reads only the role the team remembers creating.",
      "Ignores bindings created by charts or controllers.",
      "Assumes the namespace default account is harmless.",
    ],
    rubric: [
      "Starts from the subject.",
      "Enumerates all bindings.",
      "Checks wildcards and aggregation.",
      "Confirms with an authorization probe.",
    ],
  },
  {
    id: "role-vs-clusterrole",
    question:
      "When would you use a ClusterRole with a RoleBinding instead of a ClusterRoleBinding?",
    difficulty: 2,
    hints: [
      "The role defines rules; the binding defines scope.",
      "Reusing a common role does not require granting it everywhere.",
    ],
    answer:
      "A ClusterRole is a reusable set of rules, and a RoleBinding can reference it to grant those rules inside one namespace. That is useful when several namespaces need the same permissions but the subject should not reach the whole cluster. A ClusterRoleBinding is for access that genuinely applies in every namespace, such as a controller that watches cluster-scoped resources or all namespaces. I would choose the binding scope from the workload's required reach, not from the role's type.",
    followUps: [
      "Can a RoleBinding grant access to a cluster-scoped resource?",
      "How would you give a controller access to all namespaces but only one resource?",
      "What happens if the ClusterRole changes after the binding exists?",
    ],
    redFlags: [
      "Assumes ClusterRole always means cluster-wide access.",
      "Uses ClusterRoleBinding for convenience.",
      "Ignores cluster-scoped resources.",
    ],
    rubric: [
      "Separates role rules from binding scope.",
      "Chooses scope from required reach.",
      "Names a valid cluster-wide use case.",
      "Notes that role changes propagate.",
    ],
  },
  {
    id: "least-privilege-controller",
    question:
      "A controller needs to read ConfigMaps and list Pods in its own namespace. Design its RBAC and explain what you would verify.",
    difficulty: 3,
    hints: [
      "Use one dedicated ServiceAccount.",
      "Separate the verbs for each resource.",
    ],
    answer:
      "I would create a dedicated ServiceAccount and a Role in the controller's namespace. The Role would grant get on the specific ConfigMaps it needs and list and watch on Pods if it must observe changes. I would bind it with a RoleBinding, keep the token mounted because the controller calls the API, and verify with kubectl auth can-i that the negative cases fail, such as reading Secrets or listing Pods in another namespace. I would also check that the controller does not fall back to the default ServiceAccount and that no chart adds a broader binding.",
    followUps: [
      "Does the controller need watch as well as list?",
      "How would you limit access to one named ConfigMap?",
      "What would you monitor to detect drift from this design?",
    ],
    redFlags: [
      "Grants cluster-admin for convenience.",
      "Uses the default ServiceAccount.",
      "Skips negative authorization tests.",
    ],
    rubric: [
      "Creates a dedicated identity.",
      "Scopes verbs and resources separately.",
      "Uses a namespaced binding.",
      "Verifies both allowed and denied requests.",
    ],
  },
];

const checklist = [
  {
    title: "Before the workload ships",
    items: [
      "Each workload has a dedicated ServiceAccount, not the namespace default.",
      "The role lists exact verbs and resources, with no wildcard unless justified.",
      "The binding scope matches the namespaces the workload must reach.",
      "Token automount is disabled when the workload does not call the API.",
    ],
  },
  {
    title: "During an audit",
    items: [
      "Enumerate all bindings for the subject, including group subjects.",
      "Read aggregated ClusterRoles and chart-managed bindings.",
      "Probe the exact request with kubectl auth can-i.",
      "Check audit logs for successful Secret reads by the workload.",
    ],
  },
  {
    title: "After a finding",
    items: [
      "Remove the broad binding before adding a narrow one.",
      "Re-test the workload after reducing permissions.",
      "Record the required API calls so the role can stay minimal.",
      "Rotate any credential that was reachable through the excessive grant.",
    ],
  },
];

const references = [
  {
    title: "Using RBAC Authorization",
    url: "https://kubernetes.io/docs/reference/access-authn-authz/rbac/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Roles, ClusterRoles, bindings, rule evaluation, wildcards, and default roles.",
  },
  {
    title: "Configure Service Accounts for Pods",
    url: "https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "ServiceAccount identity, token projection, and automount behavior.",
  },
  {
    title: "Secrets good practices",
    url: "https://kubernetes.io/docs/concepts/security/secrets-good-practices/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Access control, encryption at rest, and reducing Secret exposure.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    rbac: {
      model: rbacModel,
      presets,
      instructions:
        "Start Healthy with one verb on one resource. Raise resource breadth to include Secrets, then switch the binding to cluster scope. Finish with Scoped least privilege and confirm the scope returns to zero.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. The 12-namespace cluster, tiered counts, and privilege score are teaching values; RBAC rule evaluation is described by the Kubernetes documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["kubernetes-config-secrets", "kubernetes-multitenancy", "foundations-failure-domains"],
};
