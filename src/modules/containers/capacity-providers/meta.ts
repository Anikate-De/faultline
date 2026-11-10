import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "containers-capacity-providers",
  slug: "capacity-providers",
  title: "Capacity Providers",
  track: "containers",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["containers-placement"],
  tags: ["capacity provider", "Fargate", "EC2", "weight", "base", "placement"],
  productionQuestion:
    "A service moves to a capacity provider and tasks fail to place. Why?",
  learningDelta:
    "Capacity providers define capacity and strategy; weights, base, and instance types determine placement and cost",
  objectives: [
    "Read a capacity provider strategy and predict which provider receives each task.",
    "Explain why base is a floor and weight is a distribution rule rather than a fallback.",
    "Diagnose tasks that stay unplaced when a secondary provider runs out of capacity.",
    "Choose between Fargate and Auto Scaling group providers with cost and capacity in view.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
