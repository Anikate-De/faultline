import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-flag-default",
  slug: "composite-flag-default",
  title: "Composite: The Feature Flag Default",
  track: "case-files",
  order: 34,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["deployment-feature-flags"],
  tags: ["feature flag", "default", "rollout", "kill switch", "review"],
  productionQuestion:
    "A flag is created with the default on and the feature reaches all users. What controls prevent it?",
  learningDelta:
    "Flag defaults and targeting are production configuration; review, staged rollout, and a kill switch are required",
  objectives: [
    "Trace how a flag's default value reaches users before targeting is configured.",
    "Contain a global exposure without waiting for a full deploy rollback.",
    "Separate the code fallback value from the flag service default.",
    "Design a production flag review and staged rollout gate.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
