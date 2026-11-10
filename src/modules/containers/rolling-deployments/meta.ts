import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-rolling-deployments",
  slug: "rolling-deployments",
  title: "ECS Rolling Deployments",
  track: "containers",
  order: 8,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-deployment-circuit-breaker"],
  tags: ["rolling", "minimum healthy", "maximum percent", "draining", "health"],
  productionQuestion:
    "A rolling deployment drops below the minimum healthy percent and causes 503s. What do you check?",
  learningDelta:
    "minimumHealthyPercent and maximumPercent control rolling capacity; task draining and health checks determine actual availability",
  objectives: [
    "Calculate the healthy-task floor and surge from minimumHealthyPercent and maximumPercent.",
    "Predict when a rolling deployment will drop serving capacity below demand.",
    "Separate a stalled rollout from a rollout that is progressing but under capacity.",
    "Explain how health checks and deregistration delay affect whether a new task can serve traffic.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
