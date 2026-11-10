import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-build-once",
  slug: "build-once",
  title: "Build Once, Deploy Many",
  track: "deployment",
  order: 18,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-cicd"],
  tags: ["build once", "config injection", "environment", "artifact", "validation"],
  productionQuestion:
    "A config change requires a rebuild and staging diverges. How do you deploy the same artifact with different config?",
  learningDelta:
    "Configuration belongs outside the artifact; environment-specific config is injected at deploy time, with validation",
  objectives: [
    "Separate the immutable artifact from environment-specific configuration.",
    "Explain why baking configuration into an image forces a rebuild per environment.",
    "Predict which configuration differences produce production-only failures.",
    "Design deploy-time configuration validation that fails before traffic arrives.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
