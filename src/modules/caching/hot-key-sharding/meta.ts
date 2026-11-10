import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-hot-key-sharding",
  slug: "hot-key-sharding",
  title: "Hot Key Sharding: One Key, One Saturated Shard",
  track: "caching",
  order: 5,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["caching-hot-key-detection", "caching-redis-data-types"],
  tags: ["Redis Cluster", "hot key", "key salting", "local cache", "read replicas", "shard CPU"],
  productionQuestion:
    "One Redis key is getting 40% of traffic. Seven shards are idle and one is on fire. What do you do?",
  learningDelta:
    "A hot key is a partitioning problem; salting, local caching, and read replicas solve different parts of it, and resizing the cache does not",
  objectives: [
    "Tell a hot key from a cluster-wide capacity problem using per-shard signals.",
    "Compare local caching, key salting, and read replicas by failure mode and tradeoff.",
    "Explain why aggregate hit rate and average CPU can hide a saturated shard.",
    "Choose a mitigation whose staleness, lag, and migration cost you can defend.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  featured: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
