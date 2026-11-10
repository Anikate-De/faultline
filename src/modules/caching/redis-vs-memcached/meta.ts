import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-redis-vs-memcached",
  slug: "redis-vs-memcached",
  title: "Redis vs Memcached",
  track: "caching",
  order: 18,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["caching-redis-data-types"],
  tags: ["Memcached", "Redis", "data structures", "persistence", "multithreading", "replication"],
  productionQuestion:
    "You need sorted sets, persistence, and pub/sub. Is Memcached simpler and faster enough?",
  learningDelta:
    "Memcached is a simple multithreaded cache; Redis adds data structures, persistence, replication, and cluster semantics at operational cost",
  objectives: [
    "Compare Redis and Memcached by required primitives, not by a generic benchmark.",
    "Explain how the threading model changes the capacity story.",
    "Recognize when a missing primitive forces a second system or a database fallback.",
    "Justify the operational cost of the richer engine for a specific workload.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
