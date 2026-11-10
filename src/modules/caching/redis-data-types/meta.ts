import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-redis-data-types",
  slug: "redis-data-types",
  title: "Redis Data Types and Their Cost",
  track: "caching",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["strings", "hashes", "sorted sets", "lists", "streams", "memory overhead"],
  productionQuestion:
    "A leaderboard rewrite lowers latency but memory triples. Which data type caused it?",
  learningDelta:
    "Data type choice sets memory overhead, operation complexity, and atomicity; the wrong type makes a fast operation expensive at scale",
  objectives: [
    "Explain how a key's encoding changes memory per member and read cost.",
    "Tell a latency win from a memory cost when the payload is the same.",
    "Estimate whether a sorted set fits a fixed shard memory budget.",
    "Choose a structure by its operations, not by one benchmark.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
