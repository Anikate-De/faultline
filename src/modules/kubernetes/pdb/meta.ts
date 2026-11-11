import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "kubernetes-pdb",
  slug: "pdb",
  title: "Pod Disruption Budgets",
  track: "kubernetes",
  order: 8,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["kubernetes-pods-deployments", "kubernetes-scheduling"],
  tags: ["PDB", "voluntary disruption", "drain", "minAvailable", "maxUnavailable"],
  productionQuestion:
    "A node drain is blocked during an incident. What does the PDB actually guarantee?",
  learningDelta:
    "PDBs bound voluntary disruptions, not failures; minAvailable and maxUnavailable interact with replicas and readiness",
  objectives: [
    "Compute the disruptions a PDB allows from replicas, readiness, and minAvailable.",
    "Explain why a drain can block when healthy pods are already below the budget.",
    "Distinguish a voluntary disruption from a node or pod failure.",
    "Choose a budget that protects availability without making maintenance impossible.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
