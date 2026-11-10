import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-task-definitions",
  slug: "task-definitions",
  title: "ECS Task Definitions",
  track: "containers",
  order: 1,
  difficulty: 1,
  minutes: 14,
  prerequisites: ["foundations-use-red"],
  tags: ["task definition", "revision", "image", "CPU", "memory", "env"],
  productionQuestion:
    "A task restarts with different environment variables than the last run. Where do you look?",
  learningDelta:
    "A task definition is an immutable revision of image, CPU, memory, env, volumes, and IAM; services pin a revision",
  objectives: [
    "Read a task definition revision and identify the image, resource, environment, volume, and role fields.",
    "Explain why a new revision does not change a running service by itself.",
    "Trace a task launch back to the revision that produced its environment.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
