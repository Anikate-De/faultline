import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-chunk-migration",
  slug: "chunk-migration",
  title: "Chunk Migration",
  track: "mongodb",
  order: 11,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-hot-shard"],
  tags: ["chunk migration", "balancer", "I/O", "metadata", "throttle"],
  productionQuestion: "The balancer starts migrating chunks and p99 rises. Why?",
  learningDelta:
    "Chunk migration copies data and updates metadata; it consumes I/O and network and can compete with application traffic",
  objectives: [
    "Trace the copy, catch-up, metadata update, and deletion phases of a chunk migration.",
    "Explain how migration rate, chunk size, and shared I/O capacity affect application latency.",
    "Separate migration load from a hot key or a capacity shortfall.",
    "Control migration with rate, windows, and throttling instead of turning the balancer off forever.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
