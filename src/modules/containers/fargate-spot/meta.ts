import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-fargate-spot",
  slug: "fargate-spot",
  title: "Fargate Spot",
  track: "containers",
  order: 26,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-capacity-providers"],
  tags: ["Fargate Spot", "interruption", "drain", "stateless", "cost"],
  productionQuestion:
    "Fargate Spot is cheaper but tasks disappear. Which workloads fit?",
  learningDelta:
    "Fargate Spot uses spare capacity with interruption notices; stateless, retryable, and drained workloads tolerate it",
  objectives: [
    "Explain how Fargate Spot interruptions arrive and how much notice the task gets.",
    "Keep a minimum healthy floor on Fargate while sending flexible work to Fargate Spot.",
    "Tune graceful shutdown so an interruption does not cut in-flight work.",
    "Decide which workloads are interruption-tolerant and which need on-demand capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
