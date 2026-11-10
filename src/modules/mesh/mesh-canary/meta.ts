import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-canary",
  slug: "mesh-canary",
  title: "Canary Through the Mesh",
  track: "mesh",
  order: 11,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-canary-metric-gate"],
  tags: ["canary", "metric gate", "sample size", "capacity", "rollback"],
  productionQuestion:
    "The canary has 5% traffic and no errors; can you increase to 100%?",
  learningDelta:
    "A canary needs a representative metric gate, enough traffic, and capacity headroom; low traffic hides tail failures",
  objectives: [
    "Explain what a mesh-weighted canary proves and what its traffic share leaves untested.",
    "Compute the canary sample size from weight, request rate, and gate window.",
    "Compare canary per-pod density with production density before promoting.",
    "Choose a gate and rollback condition that cover capacity at 100%.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
