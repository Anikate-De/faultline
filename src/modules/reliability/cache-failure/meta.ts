import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-cache-failure",
  slug: "cache-failure",
  title: "Cache Failure",
  track: "reliability",
  order: 20,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-cache-stampede"],
  tags: ["cache failure", "origin load", "stampede", "recovery", "shed"],
  productionQuestion:
    "Redis is down and the database immediately saturates. What is the incident plan?",
  learningDelta:
    "Cache failure shifts load to the origin; load shedding, negative caching, and a staged recovery prevent a second outage",
  objectives: [
    "Quantify the origin load created by losing a given cache hit rate.",
    "Protect the origin with shedding and stale or negative responses before restoring the cache.",
    "Explain why an immediate full cache restart can cause a second outage.",
    "Sequence cache recovery so the origin and the cache warm up together.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
