import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-connection-pool",
  slug: "connection-pool",
  title: "Redis Connection Pool Exhaustion",
  track: "caching",
  order: 24,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-connection-pools"],
  tags: ["connection pool", "wait time", "max clients", "multiplexing", "failover"],
  productionQuestion:
    "Services time out waiting for a Redis connection while Redis CPU is low. What is the bottleneck?",
  learningDelta:
    "Pool exhaustion is a local queueing problem; too few connections wait, too many multiply sessions and failover churn",
  objectives: [
    "Use arrival rate and service time to calculate the concurrency a pool must cover.",
    "Distinguish pool wait from Redis latency using Redis CPU, pool wait, and queue depth together.",
    "Size a pool without exceeding the fleet's Redis connection budget.",
    "Explain why a large pool makes failover and reconnect storms worse.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
