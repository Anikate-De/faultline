import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-rbac",
  slug: "rbac",
  title: "RBAC and Service Accounts",
  track: "kubernetes",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["kubernetes-config-secrets", "foundations-failure-domains"],
  tags: ["RBAC", "service account", "role", "rolebinding", "verbs", "least privilege"],
  productionQuestion: "A pod can read every Secret in its namespace. Which binding allowed it?",
  learningDelta:
    "RBAC is additive allow rules bound to subjects; service accounts, roles, and bindings must be scoped by namespace and verbs",
  objectives: [
    "Trace an API request from a ServiceAccount through its bindings to a role rule.",
    "Distinguish a Role from a ClusterRole and a RoleBinding from a ClusterRoleBinding.",
    "Find the binding that grants a workload more access than it needs.",
    "Reduce a wildcard grant to a scoped set of verbs and resources.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
