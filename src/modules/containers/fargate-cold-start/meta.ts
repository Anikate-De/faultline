import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-fargate-cold-start",
  slug: "fargate-cold-start",
  title: "Fargate Cold Starts",
  track: "containers",
  order: 9,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["containers-target-tracking"],
  tags: ["cold start", "scheduling", "image pull", "startup", "health check"],
  productionQuestion:
    "Autoscaling adds tasks but p99 still spikes for two minutes. Why?",
  learningDelta:
    "Fargate tasks need scheduling, image pull, startup, and health check time before serving; scaling must anticipate it",
  objectives: [
    "Break a Fargate cold start into scheduling, image pull, application startup, and health-check phases.",
    "Predict whether a scale-out can become serving capacity before a known traffic spike.",
    "Distinguish a scaling decision that is too late from one that is correct but blocked by startup time.",
    "Reduce the gap with earlier scaling, faster startup, or warm capacity.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
