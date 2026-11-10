import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-outbox",
  slug: "outbox",
  title: "Transactional Outbox",
  track: "streaming",
  order: 29,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-idempotency"],
  tags: ["outbox", "dual write", "CDC", "at-least-once", "consistency"],
  productionQuestion:
    "The database commit succeeds and the Kafka publish fails. How do you keep them consistent?",
  learningDelta:
    "The outbox pattern writes the event in the same transaction and publishes it asynchronously, using polling or CDC",
  objectives: [
    "Explain why a database commit and a broker publish cannot be one atomic operation.",
    "Predict lost or phantom events from a dual write under publish failure.",
    "Compare polling and change data capture for draining an outbox.",
    "Design an at-least-once publisher and an idempotent consumer.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
