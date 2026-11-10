import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-big-keys",
  slug: "big-keys",
  title: "Big Keys: One Key, Many Problems",
  track: "caching",
  order: 21,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-redis-data-types"],
  tags: ["big key", "event loop", "allocation", "bandwidth", "shard imbalance"],
  productionQuestion:
    "Redis latency spikes every time a 50MB key is read. Why?",
  learningDelta:
    "Big keys consume bandwidth, block the single-threaded event loop during operations, and create uneven shard memory",
  objectives: [
    "Explain why one large value delays every command on its shard, not only the read that fetched it.",
    "Separate event-loop blocking from bandwidth cost and from memory imbalance.",
    "Find a big key with SCAN-based sampling, MEMORY USAGE, and per-shard latency instead of a cluster average.",
    "Split or remove a big key without assuming that splitting alone reduces the bytes a read must return.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
