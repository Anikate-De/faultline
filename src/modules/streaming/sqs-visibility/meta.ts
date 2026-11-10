import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-sqs-visibility",
  slug: "sqs-visibility",
  title: "SQS Visibility Timeout",
  track: "streaming",
  order: 26,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-consumer-groups"],
  tags: ["SQS", "visibility timeout", "duplicate", "heartbeat", "DLQ"],
  productionQuestion:
    "A consumer takes longer than the visibility timeout and the message is processed twice. What do you change?",
  learningDelta:
    "Visibility timeout hides a message while it is processed; it must exceed processing time or be extended, and failures need a DLQ",
  objectives: [
    "Explain what the visibility timeout hides and when the message becomes visible again.",
    "Predict duplicate deliveries when processing time exceeds visibility.",
    "Choose between a longer timeout, heartbeat extension, and a DLQ.",
    "Design a retry path that does not turn slow processing into repeated side effects.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
