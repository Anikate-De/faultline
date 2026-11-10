import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-eviction-policies",
  slug: "eviction-policies",
  title: "Eviction Policies: Protect the Working Set",
  track: "caching",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["caching-redis-data-types"],
  tags: ["maxmemory", "LRU", "LFU", "volatile", "noeviction", "hit rate"],
  productionQuestion:
    "Redis is at maxmemory and hit rate collapses. Which keys are being evicted?",
  learningDelta:
    "allkeys policies may evict hot data; volatile policies only evict keys with TTL; policy must match the cache's purpose",
  objectives: [
    "Predict which keys an eviction policy can remove under memory pressure.",
    "Tell a falling hit rate from rejected writes as the failure signal.",
    "Choose between allkeys and volatile policies from the key mix.",
    "Size maxmemory with headroom for the working set and buffers.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
