import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-locality",
  slug: "locality",
  title: "Locality-Aware Load Balancing",
  track: "mesh",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-mtls"],
  tags: ["locality", "zone", "failover", "capacity", "cost"],
  productionQuestion: "Cross-zone traffic costs rise after a mesh rollout. What policy changed?",
  learningDelta:
    "Locality-aware balancing prefers local endpoints but fails over when local capacity or health is insufficient",
  objectives: [
    "Explain how locality preference keeps traffic in a zone while endpoints are healthy.",
    "Distinguish local capacity pressure from global capacity shortage.",
    "Quantify the latency and cost of cross-zone spillover.",
    "Choose between strict locality and available failover for a hot zone.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
