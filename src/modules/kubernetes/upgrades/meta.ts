import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-upgrades",
  slug: "upgrades",
  title: "Cluster Upgrades and Version Skew",
  track: "kubernetes",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["kubernetes-pods-deployments", "kubernetes-scheduling"],
  tags: ["version skew", "deprecation", "drain", "cordon", "upgrade"],
  productionQuestion: "The control plane is upgraded but nodes are two minor versions behind. What breaks?",
  learningDelta:
    "Version skew, removed APIs, and draining determine upgrade safety; control plane and kubelet versions have supported bounds",
  objectives: [
    "Check control plane and kubelet versions against the supported skew.",
    "Explain why a removed API can fail a workload even when the skew is valid.",
    "Plan cordon, drain, and capacity so an upgrade does not remove serving capacity.",
    "Choose the order of control plane and node upgrades.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
