import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-failover-dns",
  slug: "failover-dns",
  title: "Database Failover and DNS",
  track: "databases",
  order: 11,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["failover", "DNS", "connection pool", "TTL", "writer endpoint", "reconnect"],
  productionQuestion:
    "The database failed over but the app still writes to the old primary. What did DNS do?",
  learningDelta:
    "Managed failover updates a DNS name, but client caches, connection pools, and TTLs determine how fast traffic moves",
  objectives: [
    "Trace a writer failover from the database event through DNS resolution and client reconnection.",
    "Explain why a short DNS TTL does not fix a pool that keeps using stale connections.",
    "Estimate time to new writer from DNS TTL, pool recycle time, and reconnect delay.",
    "Reduce failover time without creating a synchronized reconnect storm.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
