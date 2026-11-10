import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-feature-flags",
  slug: "feature-flags",
  title: "Feature Flags",
  track: "deployment",
  order: 4,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-canary"],
  tags: ["feature flag", "release", "targeting", "default", "cleanup"],
  productionQuestion:
    "The code is deployed but the feature must stay off for one tenant. What do you use?",
  learningDelta:
    "Flags separate deploy from release; flag scope, defaults, and cleanup determine safety and long-term risk",
  objectives: [
    "Explain the difference between deploying code and releasing a feature.",
    "Predict exposure from a flag default, targeting rules, and percentage rollout.",
    "Recognize why a default-on flag is global exposure, not a safe fallback.",
    "Design flag ownership, kill switches, and cleanup to limit long-term risk.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
