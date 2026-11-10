import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-scale-to-zero",
  slug: "scale-to-zero",
  title: "Scale to Zero",
  track: "capacity",
  order: 21,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["containers-fargate-cold-start"],
  tags: ["scale to zero", "cold start", "state", "floor", "cost"],
  productionQuestion:
    "A dev environment is idle 80% of the time. Can it scale to zero?",
  learningDelta:
    "Scale-to-zero saves idle cost but adds cold-start latency and state loss; production-critical paths usually need a floor",
  objectives: [
    "Separate idle cost savings from the wake-up latency a scale-to-zero policy adds.",
    "Explain why a floor of one task changes both the cost and the failure mode.",
    "Diagnose the first-request timeout from idle policy, cold start, and client timeout.",
    "Choose a scale-to-zero policy for a workload class and defend the tradeoff.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
