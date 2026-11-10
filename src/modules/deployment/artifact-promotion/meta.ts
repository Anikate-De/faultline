import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-artifact-promotion",
  slug: "artifact-promotion",
  title: "Artifact Promotion",
  track: "deployment",
  order: 25,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["deployment-immutable-artifacts"],
  tags: ["promotion", "environment", "provenance", "config", "gate"],
  productionQuestion:
    "A release is approved in staging; what exactly moves to production?",
  learningDelta:
    "Promotion moves the same immutable artifact and provenance, with environment config applied separately",
  objectives: [
    "Describe what a promotion record must contain to be auditable.",
    "Explain why rebuilding during promotion loses the staged result.",
    "Keep environment configuration outside the promoted artifact.",
    "Verify the promoted digest at production admission.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
