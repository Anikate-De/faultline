import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-read-replicas",
  slug: "read-replicas",
  title: "Read Replicas: Offload Without Staleness Surprises",
  track: "caching",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-redis-persistence"],
  tags: ["replica", "replication lag", "read routing", "staleness", "failover"],
  productionQuestion:
    "Read replicas cut Redis CPU but users see stale data. What is the tradeoff?",
  learningDelta:
    "Replicas offload reads but replicate asynchronously; lag creates staleness, and hot-key reads can saturate a replica instead",
  objectives: [
    "Separate primary CPU relief from the freshness cost of replica reads.",
    "Quantify staleness from replication lag and the share of reads routed to replicas.",
    "Explain why adding replicas can move the bottleneck instead of removing it.",
    "Choose read routing and a failover plan that match the freshness budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
