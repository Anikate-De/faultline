import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-retry-storm",
  slug: "composite-retry-storm",
  title: "Composite: The Retry Storm That Outlived the Failure",
  track: "case-files",
  order: 21,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["foundations-retry-backoff-jitter"],
  tags: ["retry storm", "amplification", "breaker", "budget", "recovery"],
  productionQuestion:
    "The dependency is healthy again but traffic keeps growing. What is still wrong?",
  learningDelta:
    "Retry amplification can persist after the trigger clears; retry budgets and breakers must be reduced before tuning the dependency",
  objectives: [
    "Separate the original trigger from the retry amplification that kept the incident alive.",
    "Choose a first mitigation that reduces offered load instead of adding capacity.",
    "Design a retry budget and breaker that include deadline-exceeded outcomes.",
    "Explain why dependency recovery does not imply application recovery.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
