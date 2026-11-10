import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-dark-launch",
  slug: "dark-launch",
  title: "Dark Launches",
  track: "deployment",
  order: 21,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-feature-flags"],
  tags: ["dark launch", "flag", "internal traffic", "verification", "exposure"],
  productionQuestion:
    "The feature must be deployed for weeks before launch. How do you keep it dark?",
  learningDelta:
    "Dark launches deploy inactive code paths behind flags and verify them with synthetic or internal traffic",
  objectives: [
    "Explain how a dark launch separates deployment from user exposure.",
    "Design a flag default and targeting rule that keeps external users out.",
    "Use internal or synthetic traffic to verify an inactive path.",
    "Recognize the signals that a dark path has become user-visible.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
