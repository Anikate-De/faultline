import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-long-transactions",
  slug: "long-transactions",
  title: "Long Transactions: Locks, Bloat, and Lag",
  track: "databases",
  order: 17,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["long transaction", "snapshot", "lock", "vacuum", "replication lag"],
  productionQuestion:
    "A reporting query runs for 40 minutes and replication lag climbs. What is the chain?",
  learningDelta:
    "Long transactions hold snapshots and locks, delay vacuum, and can block replication; they turn a read into a system-wide problem",
  objectives: [
    "Trace how an open transaction's snapshot prevents vacuum from removing dead row versions.",
    "Separate lock waits caused by row locks from freshness lag caused by an uncommitted write transaction.",
    "Choose the first metric to inspect when a reporting query correlates with write timeouts and replica lag.",
    "Bound transaction duration with timeouts and isolate reporting reads without breaking correctness.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
