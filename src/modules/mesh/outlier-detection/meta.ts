import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mesh-outlier-detection",
  slug: "outlier-detection",
  title: "Outlier Detection",
  track: "mesh",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mesh-circuit-breaking"],
  tags: ["outlier detection", "ejection", "consecutive errors", "percentage", "recovery"],
  productionQuestion: "One pod returns errors and Envoy ejects healthy pods too. What threshold is wrong?",
  learningDelta:
    "Outlier detection ejects hosts based on consecutive errors and ejection percentage; overly aggressive settings remove capacity",
  objectives: [
    "Explain how passive outlier detection decides that a host is bad.",
    "Predict how consecutive errors and max ejection percentage change capacity.",
    "Recognize a death spiral where ejection removes healthy capacity.",
    "Recover a cluster without disabling detection entirely.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
