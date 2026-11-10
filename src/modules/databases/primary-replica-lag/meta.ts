import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-primary-replica-lag",
  slug: "primary-replica-lag",
  title: "Replication Lag: Measure It Before You Trust It",
  track: "databases",
  order: 2,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["replication lag", "apply lag", "byte lag", "read-after-write", "staleness"],
  productionQuestion: "The replica is healthy but users see stale data. Which lag metric do you trust?",
  learningDelta:
    "Replication lag is both time and byte based; a replica can be current in bytes yet slow to apply, and vice versa",
  objectives: [
    "Compare time-based lag with byte-based lag and explain when each hides a backlog.",
    "Distinguish WAL that has not arrived from WAL that has arrived but not been replayed.",
    "Estimate stale reads from the replay backlog and the read freshness target.",
    "Choose the metric that matches the failure: transfer, replay, or recent-transaction delay.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
