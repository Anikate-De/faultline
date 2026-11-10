import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-partition-count",
  slug: "partition-count",
  title: "Partition Count: More Is Not Free",
  track: "streaming",
  order: 6,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["streaming-kafka-partitions"],
  tags: ["partition count", "metadata", "rebalance", "file handles", "latency"],
  productionQuestion: "The topic has 200 partitions and failover takes minutes. What did the partition count cost?",
  learningDelta:
    "More partitions add parallelism but increase metadata, rebalance time, file handles, and end-to-end latency",
  objectives: [
    "Size a partition count from throughput, consumer parallelism, and headroom.",
    "Explain how partition count raises metadata, rebalance, and file-handle cost.",
    "Diagnose slow controller failover and rebalance from partition count.",
    "Choose a partition count with a tested failover and rollback plan.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
