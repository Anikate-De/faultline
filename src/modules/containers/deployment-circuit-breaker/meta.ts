import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-deployment-circuit-breaker",
  slug: "deployment-circuit-breaker",
  title: "ECS Deployment Circuit Breaker",
  track: "containers",
  order: 7,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-services"],
  tags: ["circuit breaker", "rollback", "deployment", "health check", "failure threshold"],
  productionQuestion:
    "A new task revision fails health checks and the deployment hangs. How do you make ECS roll back?",
  learningDelta:
    "The deployment circuit breaker detects repeated task failures and can roll back automatically when configured",
  objectives: [
    "Explain what the ECS deployment circuit breaker monitors during a rolling deployment.",
    "Configure automatic rollback and a failure threshold that matches startup behavior.",
    "Distinguish a deployment that is slow from one that is failing and will not recover.",
    "Verify a rollback and the capacity it restores.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
