import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-visibility-timeout",
  slug: "composite-visibility-timeout",
  title: "Composite: The Message That Processed Twice",
  track: "case-files",
  order: 31,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["streaming-sqs-visibility"],
  tags: ["SQS", "visibility timeout", "duplicate", "idempotency", "throughput"],
  productionQuestion:
    "A slow consumer exceeds visibility timeout and the same message is processed twice. What do you change?",
  learningDelta:
    "Visibility timeout must exceed processing time or be extended; idempotency is the backstop when duplicates happen",
  objectives: [
    "Recognize redelivery caused by a visibility timeout shorter than processing time.",
    "Distinguish duplicate delivery from duplicate side effects.",
    "Choose a mitigation that protects writes already in flight.",
    "Design a timeout and idempotency policy that survives variable processing time.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
