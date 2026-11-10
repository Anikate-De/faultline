import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-negative-caching",
  slug: "negative-caching",
  title: "Negative Caching and Bloom Filters",
  track: "caching",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-cache-penetration"],
  tags: ["negative cache", "Bloom filter", "false positive", "TTL", "memory"],
  productionQuestion:
    "A scraper requests 10k random IDs per second. How do you protect the database?",
  learningDelta:
    "Negative caching stores absence with a short TTL; Bloom filters reject definitely-absent keys with a tunable false-positive rate",
  objectives: [
    "Size a negative cache TTL against key creation, repetition, and memory.",
    "Explain why a Bloom filter has false positives but no false negatives for its source set.",
    "Distinguish a false positive that adds database load from a stale marker that rejects a valid key.",
    "Choose between an exact negative cache and a probabilistic filter for a given traffic shape.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
