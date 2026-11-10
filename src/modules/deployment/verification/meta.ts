import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-verification",
  slug: "verification",
  title: "Deployment Verification",
  track: "deployment",
  order: 9,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-smoke-tests"],
  tags: ["verification", "smoke test", "critical path", "dependency", "synthetic"],
  productionQuestion:
    "The deploy is green but the checkout path is broken. What verification was missing?",
  learningDelta:
    "Verification must exercise critical user paths, dependencies, and data, not just process health",
  objectives: [
    "Distinguish process health from verification of a user outcome.",
    "Choose checks that cover critical paths, real dependencies, and data read-back.",
    "Recognize a deployment gate that passes while a critical path is broken.",
    "Block promotion when verification coverage is incomplete.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
