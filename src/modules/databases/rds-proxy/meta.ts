import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-rds-proxy",
  slug: "rds-proxy",
  title: "RDS Proxy: Managed Pooling and Failover",
  track: "databases",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-pgbouncer"],
  tags: ["RDS Proxy", "pooling", "failover", "connection storm", "limits"],
  productionQuestion:
    "A database failover causes a connection storm and a long outage. How does RDS Proxy change it?",
  learningDelta:
    "RDS Proxy pools and holds connections, masking failover from clients, but adds a hop and has its own limits",
  objectives: [
    "Explain how RDS Proxy keeps idle application connections during a database failover.",
    "Distinguish the client connection population from the database connection pool.",
    "Size the proxy pool so the new writer is not overwhelmed after failover.",
    "Name when a proxy makes an outage worse: too large a pool, pinning, and borrow timeouts.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
