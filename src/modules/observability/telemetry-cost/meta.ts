import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-telemetry-cost",
  slug: "telemetry-cost",
  title: "Telemetry Cost Governance",
  track: "observability",
  order: 34,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-datadog-metric-cost"],
  tags: ["telemetry cost", "budget", "cardinality", "sampling", "retention", "ownership"],
  productionQuestion:
    "Telemetry cost grows faster than traffic and no one owns it. What is the governance model?",
  learningDelta:
    "Cost governance uses budgets, cardinality limits, sampling, retention tiers, and ownership; observability is a product with a unit cost",
  objectives: [
    "Build a unit-cost model for metrics, logs, and traces.",
    "Separate cost growth caused by traffic from growth caused by cardinality and retention.",
    "Defend a telemetry cut by naming the coverage it preserves and the coverage it loses.",
    "Assign ownership and a review cadence for a telemetry budget.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
