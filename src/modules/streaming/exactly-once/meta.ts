import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-exactly-once",
  slug: "exactly-once",
  title: "Exactly-Once Semantics",
  track: "streaming",
  order: 15,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["streaming-transactions"],
  tags: ["exactly-once", "transactions", "idempotent sink", "atomicity", "effect"],
  productionQuestion:
    "Kafka is configured for exactly-once, but the sink still has duplicates. Why?",
  learningDelta:
    "Kafka transactions make broker writes atomic; end-to-end exactly-once requires idempotent sinks or transactional outputs",
  objectives: [
    "Separate broker-level exactly-once guarantees from the effect a sink applies.",
    "Trace how a retry after a sink write creates a duplicate even when Kafka transactions are enabled.",
    "Choose between an idempotent sink and a transactional output for a given downstream system.",
    "Name the latency and operational costs that end-to-end exactly-once adds.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
