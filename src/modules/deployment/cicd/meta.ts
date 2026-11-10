import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-cicd",
  slug: "cicd",
  title: "CI/CD Pipeline Design",
  track: "deployment",
  order: 16,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-rolling"],
  tags: ["CI/CD", "caching", "parallelism", "gate", "lead time"],
  productionQuestion:
    "The pipeline takes 90 minutes and teams bypass it. What do you optimize?",
  learningDelta:
    "Pipeline speed and reliability determine adoption; parallelism, caching, and staged gates reduce lead time without skipping safety",
  objectives: [
    "Break lead time into work, queue, retry, and approval components.",
    "Explain why feedback time drives pipeline adoption and bypass.",
    "Predict the effect of parallelism, caching, and flaky tests on lead time.",
    "Reduce lead time without removing the safety gates that matter.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
