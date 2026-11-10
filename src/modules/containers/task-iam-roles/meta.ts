import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-task-iam-roles",
  slug: "task-iam-roles",
  title: "Task IAM Roles",
  track: "containers",
  order: 20,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-failure-domains"],
  tags: ["task role", "execution role", "least privilege", "credentials", "trust"],
  productionQuestion:
    "A task needs S3 access but the node role can read everything. What do you change?",
  learningDelta:
    "Task roles are per-task credentials delivered by the agent; execution roles are separate and used to pull images and write logs",
  objectives: [
    "Separate the task role from the execution role and name what each one authorizes.",
    "Trace how an ECS task receives temporary credentials without static access keys.",
    "Scope a task policy to the workload's real access need without breaking image pulls or logs.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
