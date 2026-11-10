import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-hot-shard-cluster",
  slug: "hot-shard-cluster",
  title: "Hot Shard in Redis Cluster",
  track: "caching",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-hot-key-sharding"],
  tags: ["hash slot", "Redis Cluster", "resharding", "key distribution", "hot shard"],
  productionQuestion:
    "One hash slot is saturated while the cluster has free capacity. Can you move the slot?",
  learningDelta:
    "Redis Cluster distributes keys by hash slot; a hot key and its co-located keys share a shard, and resharding cannot split one key",
  objectives: [
    "Explain how a key maps to a hash slot and a shard in Redis Cluster.",
    "Separate moving a slot from splitting the traffic inside it.",
    "Predict what resharding changes when one slot owns most of the load.",
    "Choose a fix that reduces hot-slot load rather than moving it.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
