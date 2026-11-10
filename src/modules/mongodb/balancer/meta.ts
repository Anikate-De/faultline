import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-balancer",
  slug: "balancer",
  title: "The Balancer",
  track: "mongodb",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mongodb-chunk-migration"],
  tags: ["balancer", "window", "threshold", "chunk", "distribution"],
  productionQuestion:
    "Chunks are imbalanced but the balancer is off. Should you turn it on during peak?",
  learningDelta:
    "The balancer improves distribution over time but adds load; windows and thresholds determine whether it helps during an incident",
  objectives: [
    "Explain when the balancer starts migrating and when it leaves a cluster alone.",
    "Distinguish a cluster that is imbalanced from one that is actively migrating.",
    "Predict how balancing during peak traffic changes latency before it improves distribution.",
    "Choose between an immediate rebalance and a scheduled balancing window.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
