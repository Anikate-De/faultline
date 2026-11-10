import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-db-failover",
  slug: "db-failover",
  title: "Database Failover Incident",
  track: "reliability",
  order: 21,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-failover-dns"],
  tags: ["failover", "reconnect", "DNS", "pool", "recovery"],
  productionQuestion:
    "The database fails over and the app takes 10 minutes to recover. What is the sequence?",
  learningDelta:
    "Failover recovery depends on connection handling, DNS, retries, and capacity; the database may be healthy before the app is",
  objectives: [
    "Sequence a writer failover from detection through application recovery.",
    "Explain why the promoted database can be healthy while the application still fails.",
    "Separate DNS convergence, pool rebuild, and retry amplification in the recovery timeline.",
    "Reduce recovery time by draining, jittering, and bounding reconnects.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
