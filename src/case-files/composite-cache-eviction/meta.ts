import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cache-eviction",
  slug: "composite-cache-eviction",
  title: "Composite: The Eviction Policy That Dropped the Working Set",
  track: "case-files",
  order: 60,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["caching-eviction-policies"],
  tags: ["eviction", "maxmemory", "LRU", "LFU", "hit rate"],
  productionQuestion:
    "Redis is at maxmemory and hit rate falls; the eviction policy is allkeys-lru. What do you change?",
  learningDelta:
    "Eviction policy must match data value; allkeys policies evict hot data while volatile policies can refuse writes when nothing is evictable",
  objectives: [
    "Read eviction rate and hit rate together to distinguish pressure from pollution.",
    "Choose an eviction policy from data value, TTL coverage, and recomputability.",
    "Predict when a volatile policy will reject writes instead of evicting.",
    "Protect the working set with isolation, TTL discipline, and capacity headroom.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
