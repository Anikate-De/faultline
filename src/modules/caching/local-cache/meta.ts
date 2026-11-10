import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-local-cache",
  slug: "local-cache",
  title: "Local Cache + Redis",
  track: "caching",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-hot-key-sharding"],
  tags: ["local cache", "L1", "hit rate", "staleness", "memory", "bypass"],
  productionQuestion:
    "Redis p99 is fine but one hot key consumes most of its capacity. Is a local cache safe?",
  learningDelta:
    "An in-process cache removes network hops for hot reads but introduces per-instance staleness and memory cost",
  objectives: [
    "Separate the latency win of a local cache from the freshness and memory costs it adds.",
    "Read a hit-rate change together with Redis operations, staleness, and per-task memory.",
    "Explain why a short TTL can overload Redis while a long TTL can exceed the freshness SLO.",
    "Choose between TTL, invalidation, bypass, and task count for a hot-read path.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
