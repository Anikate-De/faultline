import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-multi-az-scheduling",
  slug: "multi-az-scheduling",
  title: "Multi-AZ Scheduling",
  track: "containers",
  order: 23,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["containers-placement"],
  tags: ["multi-AZ", "spread", "capacity", "placement", "failure"],
  productionQuestion:
    "One AZ loses a node and too many tasks were packed there. How do you spread them?",
  learningDelta:
    "The scheduler places tasks across zones, but capacity and placement constraints can concentrate them",
  objectives: [
    "Predict how spread and binpack placement distribute tasks across three availability zones.",
    "Calculate surviving capacity after one zone is lost.",
    "Explain why a balanced pre-failure layout can still breach the desired count.",
    "Design N+1 headroom that covers the loss of the busiest zone at peak.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
