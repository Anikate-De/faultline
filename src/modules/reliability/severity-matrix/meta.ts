import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-severity-matrix",
  slug: "severity-matrix",
  title: "Severity Matrix",
  track: "reliability",
  order: 30,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-severity-levels"],
  tags: ["severity matrix", "impact", "scope", "duration", "response"],
  productionQuestion:
    "Two incidents with the same impact get different responses. What does the matrix need?",
  learningDelta:
    "A severity matrix maps user impact, scope, and duration to response levels; it must be simple enough to use under pressure",
  objectives: [
    "Map user impact, scope, and duration to a response level.",
    "Keep the matrix small enough to classify without debate.",
    "Test classification against realistic scenarios and disagreements.",
    "Explain why exceptions and extra axes make responders fall back to gut feel.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
