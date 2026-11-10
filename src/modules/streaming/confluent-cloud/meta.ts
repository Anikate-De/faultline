import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-confluent-cloud",
  slug: "confluent-cloud",
  title: "Confluent Cloud Operations",
  track: "streaming",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["streaming-partition-count"],
  tags: ["Confluent Cloud", "throughput limit", "partitions", "networking", "observability"],
  productionQuestion:
    "A managed Kafka cluster shows elevated latency and the app team cannot see brokers. What do you check?",
  learningDelta:
    "Managed Kafka exposes throughput, partition, and network limits through metrics and quotas; the broker is not yours to tune",
  objectives: [
    "Read cluster and client metrics when broker-level access is unavailable.",
    "Distinguish a quota or partition limit from a network-path latency problem.",
    "Choose a response to a quota breach that does not require tuning a broker.",
    "Explain which limits are cluster-wide and which are client-side.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
