import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-max-connections",
  slug: "max-connections",
  title: "Max Connections: The Limit Behind the Limit",
  track: "databases",
  order: 9,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["max_connections", "memory per connection", "workers", "connection storm", "queue"],
  productionQuestion: "The database has 500 max connections but dies at 300. Why?",
  learningDelta:
    "Each connection consumes memory and workers; the practical limit is lower than max_connections and depends on workload",
  objectives: [
    "Derive a safe connection count from memory, per-session work, and reserved slots.",
    "Explain why the practical limit can be below max_connections.",
    "Recognize a connection storm and the queue that forms before refusal.",
    "Choose between raising memory, lowering sessions, and adding a pooler.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
