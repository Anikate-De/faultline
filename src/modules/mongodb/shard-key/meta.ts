import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-shard-key",
  slug: "shard-key",
  title: "Shard Key Design",
  track: "mongodb",
  order: 9,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["mongodb-replica-set"],
  tags: ["shard key", "cardinality", "locality", "scatter-gather", "monotonic key"],
  productionQuestion: "One shard key gives perfect distribution but every query is scatter-gather. What do you do?",
  learningDelta:
    "Shard keys must balance write distribution and query locality; high cardinality alone is not enough",
  objectives: [
    "Evaluate a shard key by cardinality, frequency, and whether it matches the dominant query shape.",
    "Explain why a monotonically increasing ranged key concentrates new writes.",
    "Predict when a hashed key distributes writes but turns range queries into scatter-gather.",
    "Choose a compound or alternate key and state the cost of the choice.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
