import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-poison-messages",
  slug: "poison-messages",
  title: "Poison Messages",
  track: "streaming",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-slow-consumers"],
  tags: ["poison message", "validation", "retry limit", "DLQ", "ordering"],
  productionQuestion:
    "One malformed event fails every retry and the partition stops. How do you recover?",
  learningDelta:
    "A poison message blocks in-order processing; validation, retry limits, and DLQs isolate it without losing the stream",
  objectives: [
    "Recognize head-of-line blocking from a single failing record.",
    "Explain why unbounded retries turn one bad record into a stalled partition.",
    "Choose a retry budget and quarantine path that keeps the partition moving.",
    "Decide what validation belongs at the producer, the consumer, or both.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
