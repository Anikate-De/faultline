import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-key-salting",
  slug: "key-salting",
  title: "Key Salting: Spread One Key Across Shards",
  track: "caching",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-hot-key-sharding"],
  tags: ["key salting", "fan-out", "deterministic hash", "migration", "consistency"],
  productionQuestion:
    "Salting a key spreads load but changes every reader. How do you migrate safely?",
  learningDelta:
    "Salting adds a deterministic suffix to fan a hot key across shards; it requires reading all salted variants and a migration plan",
  objectives: [
    "Design a deterministic salt scheme that changes the hash slot of each variant.",
    "Explain how fan-out reads multiply work even when writes are spread.",
    "Sequence a migration that keeps unsalted readers correct during the transition.",
    "Choose between dual-write, dual-read, and a bounded shadow migration for a write-hot key.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
