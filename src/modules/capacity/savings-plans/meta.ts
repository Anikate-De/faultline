import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-savings-plans",
  slug: "savings-plans",
  title: "Savings Plans",
  track: "capacity",
  order: 9,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["capacity-headroom-cost"],
  tags: ["savings plans", "commitment", "flexibility", "forecast", "discount"],
  productionQuestion:
    "You need flexibility across instance families. Do RIs or Savings Plans fit?",
  learningDelta:
    "Savings Plans commit to usage for a discount and are more flexible than RIs, but still require accurate forecasting",
  objectives: [
    "Explain what a Savings Plan commits to and what remains on-demand.",
    "Compare Compute Savings Plans, EC2 Instance Savings Plans, and Reserved Instances.",
    "Diagnose over-commitment and under-commitment from utilization and cost.",
    "Choose a commitment level from forecast confidence rather than from the maximum discount.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
