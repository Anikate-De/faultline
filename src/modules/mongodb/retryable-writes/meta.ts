import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-retryable-writes",
  slug: "retryable-writes",
  title: "Retryable Writes",
  track: "mongodb",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-idempotency"],
  tags: ["retryable writes", "session", "transaction number", "failover", "idempotency"],
  productionQuestion:
    "A write fails during failover and the driver retries it. Could it apply twice?",
  learningDelta:
    "Retryable writes use a session and transaction number so the server can deduplicate retries within a window",
  objectives: [
    "Explain how the driver and server use a session and transaction number for a retry.",
    "Separate a transient network error from an ambiguous write result.",
    "Identify when a retry can still duplicate an effect or fail outright.",
    "Decide where retry belongs: driver, application, or an idempotent operation.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
