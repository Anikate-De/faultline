import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-redis-persistence",
  slug: "redis-persistence",
  title: "Redis Persistence: RDB, AOF, and Loss Windows",
  track: "caching",
  order: 2,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["caching-redis-data-types"],
  tags: ["RDB", "AOF", "fsync", "snapshot", "durability", "recovery"],
  productionQuestion:
    "Redis restarts and 40 seconds of writes are gone. Which persistence setting was used?",
  learningDelta:
    "RDB snapshots lose writes between snapshots; AOF reduces the loss window at fsync cost; caching may not need either",
  objectives: [
    "Quantify the loss window of RDB, AOF everysec, AOF always, and no persistence.",
    "Separate durability from restart time when choosing a mode.",
    "Explain why the default AOF policy still permits a small write loss.",
    "Choose persistence from the data's value, not from the Redis default.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
