import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-anomaly-detection",
  slug: "anomaly-detection",
  title: "Anomaly Detection Pitfalls",
  track: "observability",
  order: 22,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["observability-alert-fatigue"],
  tags: ["anomaly detection", "baseline", "seasonality", "false positive", "missing data"],
  productionQuestion:
    "The detector pages every Monday at 9 a.m. and no one is surprised. What is wrong?",
  learningDelta:
    "Statistical anomalies are not incidents; seasonality, trends, and missing data create false positives that need guardrails",
  objectives: [
    "Explain why a baseline shorter than the seasonal period misreads a normal peak.",
    "Separate detector sensitivity from the definition of an incident.",
    "Recognize how missing data changes the anomaly score and the page.",
    "Add coverage and seasonality guardrails without hiding real failures.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
