import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-transactions",
  slug: "streaming-transactions",
  title: "Kafka Transactions",
  track: "streaming",
  order: 16,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["streaming-idempotent-producer"],
  tags: ["transactions", "transactional ID", "offsets", "atomicity", "latency"],
  productionQuestion:
    "A consumer writes output and commits its offset separately, causing duplicates. How do transactions help?",
  learningDelta:
    "Transactions atomically commit produced records and consumed offsets, but add latency and require transactional consumers",
  objectives: [
    "Explain the crash window between an output write and an offset commit.",
    "Describe how sendOffsetsToTransaction makes both writes atomic.",
    "Recognize the latency and isolation-level costs of transactions.",
    "Decide when a transaction is needed and when an idempotent sink is enough.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
