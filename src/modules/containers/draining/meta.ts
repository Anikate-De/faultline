import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-draining",
  slug: "draining",
  title: "Task Draining",
  track: "containers",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["traffic-connection-draining"],
  tags: ["draining", "deregistration", "stop", "in-flight", "502"],
  productionQuestion:
    "A deployment causes 502s during task stop. What is the drain sequence?",
  learningDelta:
    "ECS deregisters a task, waits for draining, then stops it; timeout and connection behavior decide in-flight request loss",
  objectives: [
    "Order the deregistration, drain, SIGTERM, and stop steps for an ECS task.",
    "Choose a deregistration delay and stop timeout from request duration and connection behavior.",
    "Explain why a short drain window produces 502s during an otherwise healthy deployment.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
