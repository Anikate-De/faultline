import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-scheduled-scaling-race",
  slug: "scheduled-scaling-race",
  title: "Scheduled Scaling Race Condition",
  track: "capacity",
  order: 7,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["capacity-scheduled-scaling"],
  tags: ["scheduled scaling", "target tracking", "Auto Scaling", "minimum capacity", "cooldown", "change freeze"],
  productionQuestion:
    "A scheduled scale-down at 18:00 collides with an organic surge and capacity collapses. What do you change?",
  learningDelta:
    "Scheduled and dynamic scaling can race; minimum capacity, cooldowns, and change freezes prevent the overlap",
  objectives: [
    "Explain how a scheduled action and a dynamic policy both write the same desired capacity.",
    "Diagnose the overlap from desired capacity, in-service capacity, demand, and error onset.",
    "Choose a guardrail: minimum capacity, a frozen schedule, one capacity owner, or faster scale-out.",
    "Defend the cost and recovery tradeoff of each guardrail.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
