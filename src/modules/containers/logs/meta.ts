import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-logs",
  slug: "logs",
  title: "ECS Logs",
  track: "containers",
  order: 14,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["containers-task-definitions"],
  tags: ["logs", "CloudWatch", "FireLens", "stop reason", "OOM"],
  productionQuestion:
    "A task was OOM-killed and its container is gone. Where are the logs?",
  learningDelta:
    "ECS log drivers ship stdout/stderr to CloudWatch or FireLens; task stop reason and previous logs are separate signals",
  objectives: [
    "Follow one task's stdout from the container to CloudWatch Logs or FireLens.",
    "Read a stopped task's stop reason and explain why it can survive missing logs.",
    "Diagnose missing logs from driver, permission, stream, and retention causes.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
