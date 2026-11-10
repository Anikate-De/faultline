import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-connection-storm",
  slug: "mongodb-connection-storm",
  title: "Connection Storms",
  track: "mongodb",
  order: 13,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-connection-storm"],
  tags: ["connection storm", "pooling", "mongos", "backoff", "reconnect"],
  productionQuestion:
    "A network blip causes every app worker to reconnect and mongos CPU spikes. How do you dampen it?",
  learningDelta:
    "MongoDB drivers pool connections; synchronized reconnects overwhelm mongos and shards without backoff and pool limits",
  objectives: [
    "Explain how per-process connection pools turn a fleet restart into a handshake burst at mongos.",
    "Distinguish connection count, handshake rate, and request rate as separate capacity limits.",
    "Predict when jitter and pool limits dampen a reconnect storm and when they only move the spike.",
    "Size a driver pool and reconnect policy from worker count and mongos capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
