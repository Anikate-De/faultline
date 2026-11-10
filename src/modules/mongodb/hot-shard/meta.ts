import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-hot-shard",
  slug: "hot-shard",
  title: "Hot Shards",
  track: "mongodb",
  order: 10,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-shard-key"],
  tags: ["hot shard", "chunk", "balancer", "monotonic key", "hotspot"],
  productionQuestion: "One shard has 80% CPU and the others are idle. Is the balancer broken?",
  learningDelta:
    "The balancer moves chunks, but a hot key within a chunk or a monotonically increasing key can keep one shard hot",
  objectives: [
    "Diagnose a hot shard from per-shard CPU and write rate while chunk counts look balanced.",
    "Explain why moving or splitting chunks does not split one key's traffic.",
    "Distinguish a key-distribution hotspot from a balancer that is disabled or behind.",
    "Choose a fix that changes the key distribution rather than only moving the same load.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
