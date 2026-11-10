import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-queue-dlq",
  slug: "composite-queue-dlq",
  title: "Composite: The Dead Letter Queue Nobody Read",
  track: "case-files",
  order: 48,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["streaming-dlq"],
  tags: ["DLQ", "alerting", "replay", "ownership", "retention"],
  productionQuestion: "A DLQ has 2 million messages and no one noticed. What is missing?",
  learningDelta:
    "A DLQ needs alerting, ownership, replay tooling, and retention; otherwise it converts visible failures into silent data loss",
  objectives: [
    "Explain how a DLQ can hide failure instead of containing it.",
    "Choose an alert that detects lost work rather than only queue depth.",
    "Sequence a replay safely with idempotency and retention limits.",
    "Assign ownership and test the replay path before it is needed.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
