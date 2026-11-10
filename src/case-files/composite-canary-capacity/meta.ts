import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-canary-capacity",
  slug: "composite-canary-capacity",
  title: "Composite: The Canary That Passed at 5%",
  track: "case-files",
  order: 20,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["deployment-canary-metric-gate"],
  tags: ["canary", "capacity", "gate", "scale", "rollback"],
  productionQuestion:
    "The canary is clean at 5% and the full rollout fails at 100%. What was never tested?",
  learningDelta:
    "A canary must exercise capacity and shared-resource behavior at the target scale, not only error rate on a small slice",
  objectives: [
    "Identify which resources scale with fleet size rather than request rate.",
    "Turn a canary gate into a projection against hard shared limits.",
    "Choose a rollout response that preserves the ability to roll back.",
    "Design a pre-production test at the target concurrency and pool size.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
