import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-idempotency",
  slug: "idempotency",
  title: "Idempotency: Retries Without Duplicate Side Effects",
  track: "foundations",
  order: 8,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-timeouts"],
  tags: ["idempotency key", "at-least-once", "exactly-once effects", "dedupe window", "ambiguous timeout"],
  productionQuestion:
    "The payment timed out; did it charge the customer, and is it safe to retry?",
  learningDelta:
    "An idempotency key makes a retried write return the original result instead of creating a second effect",
  objectives: [
    "Explain why an ambiguous timeout makes a write unsafe to retry without a key.",
    "Design an idempotency key store with a reservation, a stored response, and a retention window.",
    "Distinguish at-least-once delivery from exactly-once effects.",
    "Choose a dedupe window and concurrency behavior that match the retry path.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
