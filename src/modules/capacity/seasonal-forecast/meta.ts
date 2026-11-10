import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "capacity-seasonal-forecast",
  slug: "seasonal-forecast",
  title: "Seasonal Forecasting",
  track: "capacity",
  order: 22,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["capacity-capacity-models"],
  tags: ["seasonality", "growth", "forecast", "uncertainty", "capacity"],
  productionQuestion:
    "Traffic grows 40% every December and the forecast is linear. What do you change?",
  learningDelta:
    "Forecasts need seasonality, growth, and uncertainty bands; capacity should be planned against a percentile, not a point estimate",
  objectives: [
    "Separate trend growth from seasonal uplift in a capacity forecast.",
    "Explain why a confidence band on a linear forecast does not fix a missing seasonal term.",
    "Diagnose an underprovisioned peak from utilization and shed load at the seasonal ramp.",
    "Choose a planning percentile and defend its idle-capacity cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
