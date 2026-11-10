import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-cost-per-request",
  slug: "cost-per-request",
  title: "Cost per Request",
  track: "capacity",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-use-red"],
  tags: ["cost per request", "unit cost", "traffic", "fixed cost", "variable cost"],
  productionQuestion:
    "The monthly bill doubled but traffic only grew 20%. What changed per request?",
  learningDelta:
    "Cost per request separates volume growth from efficiency changes and exposes the expensive path",
  objectives: [
    "Compute cost per request from fixed cost, variable cost, and traffic.",
    "Separate a volume-driven bill increase from a unit-cost increase.",
    "Identify how a shift toward an expensive request path raises unit cost at flat traffic.",
    "Choose the cost metric and breakdown that make the change attributable.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
