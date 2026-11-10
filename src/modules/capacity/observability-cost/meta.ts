import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-observability-cost",
  slug: "observability-cost",
  title: "Observability Cost per Request",
  track: "capacity",
  order: 12,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-telemetry-cost"],
  tags: ["telemetry cost", "sampling", "cardinality", "retention", "value"],
  productionQuestion:
    "Observability is 25% of infrastructure cost and growing faster than traffic. Where do you cut?",
  learningDelta:
    "Telemetry has volume, cardinality, and retention costs; sampling and tiering should follow incident value, not default retention",
  objectives: [
    "Break telemetry spend into volume, cardinality, and retention components.",
    "Identify which component is driving cost per request while traffic is flat.",
    "Choose a cut that preserves the signals used in incidents.",
    "Defend the coverage cost of each sampling or retention decision.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
