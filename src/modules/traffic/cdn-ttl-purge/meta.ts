import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "traffic-cdn-ttl-purge",
  slug: "cdn-ttl-purge",
  title: "CDN TTL and Purge",
  track: "traffic",
  order: 17,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-cdn-cache-keys"],
  tags: ["TTL", "purge", "invalidation", "versioned assets", "propagation"],
  productionQuestion:
    "A deploy needs new assets immediately but long TTLs keep old ones cached. What do you do?",
  learningDelta:
    "TTL trades freshness for hit rate; purge is fast but operationally risky and may not reach every edge immediately",
  objectives: [
    "Explain how TTL, revalidation, and purge control freshness at the edge.",
    "Measure the origin cost of short TTLs and the stale window of long TTLs.",
    "Compare overwrite, purge, and versioned URLs by freshness, origin load, and blast radius.",
    "Choose a release strategy that makes a deploy visible without a global purge.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
