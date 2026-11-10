import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-unit-economics",
  slug: "unit-economics",
  title: "Unit Economics",
  track: "capacity",
  order: 2,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["capacity-cost-per-request"],
  tags: ["unit economics", "margin", "fixed cost", "variable cost", "scale"],
  productionQuestion:
    "A feature is profitable at 1k users and loses money at 1M. Which cost dominates?",
  learningDelta:
    "Unit economics combine compute, storage, network, and observability per unit of value; fixed costs hide until scale",
  objectives: [
    "Separate contribution margin per user from total monthly profit.",
    "Diagnose why a feature that works at small scale fails at large scale.",
    "Price a feature from its variable cost and its fixed-cost recovery point.",
    "Choose the operating metric that catches margin erosion before the bill does.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
