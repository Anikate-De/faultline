import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-secrets",
  slug: "containers-secrets",
  title: "Secrets in ECS",
  track: "containers",
  order: 21,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-task-iam-roles"],
  tags: ["secrets", "Secrets Manager", "SSM", "injection", "rotation"],
  productionQuestion:
    "A database password is in an environment variable in the task definition. What is the safer path?",
  learningDelta:
    "Secrets Manager or SSM parameters can be injected at task start; image, task definition, and logs must stay free of secrets",
  objectives: [
    "Compare plaintext environment values with Secrets Manager and SSM Parameter Store references.",
    "Trace when ECS resolves a secret and why a running task keeps the value it started with.",
    "Choose a rotation path that does not depend on rebuilding the image or editing the task definition.",
    "Design a least-privilege execution role for secret injection and a log policy that does not echo values.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
