import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-idempotent-producer",
  slug: "idempotent-producer",
  title: "Idempotent Producer",
  track: "streaming",
  order: 9,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-idempotency"],
  tags: ["idempotence", "producer ID", "sequence number", "retry", "duplicate"],
  productionQuestion:
    "A producer retries a batch and the consumer sees duplicates. What fixes it?",
  learningDelta:
    "Idempotent producers use sequence numbers and producer IDs to deduplicate retries within a session",
  objectives: [
    "Explain how an ambiguous acknowledgement turns a retry into a duplicate record.",
    "Describe how a producer ID and per-partition sequence number let the broker drop a retried batch.",
    "Distinguish idempotent retry suppression from application-level and cross-session duplicate handling.",
    "Choose idempotence and in-flight settings that preserve ordering without hiding duplicates.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
