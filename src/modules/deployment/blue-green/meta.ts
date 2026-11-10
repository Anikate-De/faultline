import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-blue-green",
  slug: "blue-green",
  title: "Blue-Green Deployments",
  track: "deployment",
  order: 2,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-rolling"],
  tags: ["blue-green", "cutover", "rollback", "shared database", "schema"],
  productionQuestion:
    "A blue-green deploy is ready but the database migration is not reversible. Do you cut over?",
  learningDelta:
    "Blue-green gives fast traffic cutover and rollback, but shared state and schema changes can make the old environment unusable",
  objectives: [
    "Explain how traffic cutover and rollback work in a blue-green deployment.",
    "Separate environment readiness from shared database compatibility.",
    "Recognize when a destructive schema change breaks the rollback path.",
    "Choose an expand/contract sequence that keeps both versions compatible.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
