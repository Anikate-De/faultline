import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-shadow-traffic",
  slug: "shadow-traffic",
  title: "Shadow Traffic",
  track: "deployment",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-dark-launch"],
  tags: ["shadow traffic", "mirroring", "side effects", "load", "validation"],
  productionQuestion:
    "You need production traffic to validate a rewrite but cannot affect users. What do you do?",
  learningDelta:
    "Shadow traffic mirrors requests to the new version and discards responses; it validates behavior but doubles load and risks side effects",
  objectives: [
    "Explain how request mirroring validates a new version without returning its responses.",
    "Predict the load a shadow copy places on shared dependencies.",
    "Identify write paths that must be suppressed or isolated before mirroring.",
    "Design a shadow test that observes behavior without creating external effects.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
