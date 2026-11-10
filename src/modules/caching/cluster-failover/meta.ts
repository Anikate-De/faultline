import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-cluster-failover",
  slug: "cluster-failover",
  title: "Redis Cluster Failover",
  track: "caching",
  order: 28,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-read-replicas"],
  tags: ["failover", "replica promotion", "topology refresh", "retry", "split brain"],
  productionQuestion:
    "A primary fails over and clients see a burst of errors. What does the cluster guarantee?",
  learningDelta:
    "Redis Cluster promotes a replica after failure detection; clients must refresh topology, retry safely, and tolerate a short write outage",
  objectives: [
    "Trace failure detection, election, and replica promotion in a Redis Cluster shard.",
    "Separate the cluster's availability guarantee from the client's stale-topology behavior.",
    "Explain when a failover can lose acknowledged writes and when a partition is worse.",
    "Design a bounded retry and topology-refresh policy that recovers without a write storm.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
