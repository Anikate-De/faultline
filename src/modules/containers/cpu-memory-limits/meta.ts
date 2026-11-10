import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-cpu-memory-limits",
  slug: "cpu-memory-limits",
  title: "CPU and Memory Limits",
  track: "containers",
  order: 18,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-task-definitions"],
  tags: ["CPU limit", "memory limit", "reservation", "placement", "OOM"],
  productionQuestion:
    "One task uses all node memory and other tasks are evicted. How do limits work?",
  learningDelta:
    "Container and task limits bound CPU and memory; reservations influence placement, and exceeding memory leads to OOM",
  objectives: [
    "Distinguish a CPU reservation from a CPU limit and a memory reservation from a hard memory limit.",
    "Predict whether a task is throttled, killed, or left unplaced for a given task size.",
    "Size a task so it protects its neighbors without wasting node capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
