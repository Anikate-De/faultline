import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-warming",
  slug: "warming",
  title: "Cache Warming After a Cold Start",
  track: "caching",
  order: 27,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-cache-stampede"],
  tags: ["cache warming", "cold start", "origin load", "coalescing", "rate limit"],
  productionQuestion:
    "A Redis restart leaves an empty cache and the database is overwhelmed. How do you warm it?",
  learningDelta:
    "Cold caches shift load to the origin; controlled warming, request coalescing, and rate limits prevent a restart from becoming an outage",
  objectives: [
    "Explain why an empty cache moves read load to the origin.",
    "Choose a warmup rate that fills the hot set without saturating the database.",
    "Combine warming with coalescing so live misses do not multiply the preload.",
    "Sequence recovery: protect the origin, warm in waves, then restore traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
