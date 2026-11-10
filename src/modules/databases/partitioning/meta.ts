import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-partitioning",
  slug: "partitioning",
  title: "Partitioning and Sharding",
  track: "databases",
  order: 21,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["databases-hot-partitions"],
  tags: ["partitioning", "sharding", "routing", "cross-shard query", "archive"],
  productionQuestion: "A table is too large for one writer. Do you partition, shard, or archive?",
  learningDelta:
    "Partitioning splits one logical table for maintenance; sharding splits writers across nodes and adds routing and cross-shard complexity",
  objectives: [
    "Separate the maintenance benefit of partitioning from the write-capacity benefit of sharding.",
    "Predict when a hot shard or cross-shard query dominates latency after a split.",
    "Choose between partitioning, sharding, and archiving for a stated growth and traffic shape.",
    "Name the routing, rebalancing, and query constraints a shard key imposes.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
