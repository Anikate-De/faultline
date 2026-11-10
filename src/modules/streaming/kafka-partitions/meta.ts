import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-kafka-partitions",
  slug: "kafka-partitions",
  title: "Kafka Partitions: The Unit of Parallelism",
  track: "streaming",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["foundations-backpressure"],
  tags: ["partition", "consumer group", "parallelism", "ordering", "offset"],
  productionQuestion: "A topic has 12 partitions and 20 consumers. Why are 8 consumers idle?",
  learningDelta:
    "A partition is consumed by one consumer per group; partition count caps consumer parallelism and sets ordering scope",
  objectives: [
    "Explain why a consumer group assigns at most one consumer per partition.",
    "Calculate a topic's throughput ceiling from partition count and per-consumer capacity.",
    "Diagnose idle consumers and growing lag from assignment and per-partition load.",
    "Choose between more partitions, more consumers, and faster consumers.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
