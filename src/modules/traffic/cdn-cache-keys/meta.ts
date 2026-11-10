import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-cdn-cache-keys",
  slug: "cdn-cache-keys",
  title: "CDN Cache Keys: Hit Rate by Design",
  track: "traffic",
  order: 16,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["cache key", "hit rate", "Vary", "query string", "cookies", "origin load"],
  productionQuestion:
    "CDN hit rate is 30% and origin is overloaded. What belongs in the cache key?",
  learningDelta:
    "Cache key selection decides reuse; including irrelevant headers fragments the cache, omitting vary-worthy inputs serves wrong content",
  objectives: [
    "Trace how a CDN computes a cache key and why two identical paths can miss.",
    "Measure how high-cardinality headers, cookies, and query strings multiply cache entries.",
    "Separate a fragmentation problem from a correctness problem using hit rate and wrong-content signals.",
    "Design a key that keeps only response-variant inputs while forwarding the rest to the origin.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
