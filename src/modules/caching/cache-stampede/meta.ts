import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-cache-stampede",
  slug: "cache-stampede",
  title: "Cache Stampede: When TTL Expires at the Wrong Time",
  track: "caching",
  order: 9,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["caching-eviction-policies"],
  tags: ["cache stampede", "thundering herd", "single-flight", "TTL jitter", "stale-while-revalidate", "database load"],
  productionQuestion:
    "A popular key expires and the database CPU goes to 100%. How do you stop the herd?",
  learningDelta:
    "A stampede occurs when many concurrent misses recompute one value; single-flight, jitter, and early refresh collapse the work",
  objectives: [
    "Tell a stampede from a capacity problem by aligning database load with cache expiry.",
    "Compare single-flight, TTL jitter, and early refresh by what they collapse and what they cost.",
    "Explain why a high cache hit rate can coexist with a saturated database.",
    "Choose a mitigation that fits the product's freshness and latency budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
