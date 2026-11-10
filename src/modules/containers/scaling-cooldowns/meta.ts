import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-scaling-cooldowns",
  slug: "scaling-cooldowns",
  title: "Scaling Cooldowns and Stabilization",
  track: "containers",
  order: 6,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["containers-step-scaling"],
  tags: ["cooldown", "stabilization", "noise", "scale-in", "warm capacity"],
  productionQuestion:
    "A one-minute spike triggers 30 tasks and then they all scale in. What do you change?",
  learningDelta:
    "Cooldowns and stabilization windows filter noise but delay response; the right values depend on workload duration",
  objectives: [
    "Explain how scale-out and scale-in cooldowns change a policy's response to bursty traffic.",
    "Predict when a short burst will cause unnecessary capacity or a premature scale-in.",
    "Choose cooldown values from burst duration, task startup time, and the cost of warm capacity.",
    "Explain why a longer scale-in hold reduces churn but leaves idle tasks after the burst.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
