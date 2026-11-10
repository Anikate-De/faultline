import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-error-grouping",
  slug: "error-grouping",
  title: "Error Tracking: Grouping and Fingerprints",
  track: "observability",
  order: 33,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-structured-logging"],
  tags: ["error tracking", "fingerprint", "grouping", "stack trace", "noise"],
  productionQuestion:
    "One error group has 40k events and three unrelated root causes. How do you split it?",
  learningDelta:
    "Error grouping uses fingerprints; stable, specific fingerprints preserve distinct causes without exploding issue count",
  objectives: [
    "Explain how a fingerprint turns many error events into one issue.",
    "Choose fingerprint inputs that separate causes without multiplying noise.",
    "Diagnose a new error class buried inside an existing group.",
    "Triage an error stream by cause and release rather than by raw event count.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
