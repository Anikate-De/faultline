import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-cache-penetration",
  slug: "cache-penetration",
  title: "Cache Penetration: Requests for Missing Keys",
  track: "caching",
  order: 15,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-eviction-policies"],
  tags: ["cache penetration", "negative cache", "Bloom filter", "miss", "database load"],
  productionQuestion:
    "Random IDs miss the cache and hit the database every time. What do you add?",
  learningDelta:
    "Penetration is repeated lookup of absent keys; negative caching and Bloom filters reject impossible keys early",
  objectives: [
    "Separate cache penetration from a stampede and from an ordinary low hit rate.",
    "Explain what a negative cache stores and why its TTL is a correctness decision.",
    "Read a Bloom filter's false-positive rate from its bits per key.",
    "Choose a filter placement that stops absent-key traffic before the database.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
