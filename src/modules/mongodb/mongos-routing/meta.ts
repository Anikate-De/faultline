import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-mongos-routing",
  slug: "mongos-routing",
  title: "Mongos Routing and Targets",
  track: "mongodb",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-sharding"],
  tags: ["mongos", "targeting", "scatter-gather", "merge", "query plan"],
  productionQuestion: "A query is slow only when it goes through mongos. What do you inspect?",
  learningDelta:
    "Mongos routes by shard key, merges results, and applies targeting; scatter-gather and merge overhead can dominate",
  objectives: [
    "Trace a query through mongos: cached metadata, shard targeting, fan-out, and result merge.",
    "Separate router merge cost from shard execution cost using per-component signals.",
    "Explain why a broad query can be fast on one shard and slow only through the router.",
    "Choose a fix that reduces fan-out or merge width instead of adding shards blindly.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
