import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-ecs-exec",
  slug: "ecs-exec",
  title: "ECS Exec",
  track: "containers",
  order: 13,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["containers-task-definitions"],
  tags: ["ECS Exec", "SSM", "debugging", "audit", "task role"],
  productionQuestion:
    "A task is unhealthy but you cannot shell in. How do you inspect it?",
  learningDelta:
    "ECS Exec uses SSM to run commands in a running task; it requires task role, SSM agent, and audit controls",
  objectives: [
    "List the requirements for ECS Exec: the service flag, the task role, and the SSM agent.",
    "Run a diagnostic command in a live task and preserve an audit record of the session.",
    "Distinguish a missing Exec prerequisite from a missing shell or binary in the container.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
