import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-services",
  slug: "services",
  title: "ECS Services and Desired Count",
  track: "containers",
  order: 2,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["containers-task-definitions"],
  tags: ["desired count", "scheduler", "service", "reconciliation", "deployment"],
  productionQuestion:
    "The service says 10 tasks desired but only 6 are running. What does ECS do next?",
  learningDelta:
    "A service continuously reconciles desired count with running tasks through the scheduler and deployment configuration",
  objectives: [
    "Explain the difference between desired count and running count.",
    "Trace how the service scheduler replaces stopped or unhealthy tasks.",
    "Diagnose a service that cannot reach its desired count because of capacity or health checks.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
