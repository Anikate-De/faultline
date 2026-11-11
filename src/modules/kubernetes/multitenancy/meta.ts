import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-multitenancy",
  slug: "multitenancy",
  title: "Namespaces, Quotas, and Isolation",
  track: "kubernetes",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-rbac", "kubernetes-scheduling"],
  tags: ["namespace", "resource quota", "limit range", "network policy", "admission"],
  productionQuestion: "Two teams share a cluster and one team's pods starve the other. What isolation is missing?",
  learningDelta:
    "Namespaces organize objects; quotas, limit ranges, network policies, and admission isolate resources, not namespaces alone",
  objectives: [
    "Separate namespace organization from actual resource and network isolation.",
    "Use a ResourceQuota and a LimitRange to bound a team's consumption.",
    "Explain why a NetworkPolicy needs an enforcing CNI and a default-deny posture.",
    "Recognize when a shared cluster needs a stronger boundary than a namespace.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
