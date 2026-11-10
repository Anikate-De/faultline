import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-metrics-types",
  slug: "metrics-types",
  title: "Counters, Gauges, and Histograms",
  track: "observability",
  order: 2,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-use-red"],
  tags: ["counter", "gauge", "histogram", "summary", "reset", "rate"],
  productionQuestion:
    "A counter is reset by a deploy and the error graph goes negative. What type or query is wrong?",
  learningDelta:
    "Counters need rate(), gauges are point-in-time, histograms support quantiles; mixing them produces nonsense",
  objectives: [
    "Match each metric type to the query functions that preserve its meaning.",
    "Explain why a counter reset breaks delta() but not rate().",
    "Tell a counter from a gauge when a value can go down.",
    "Choose between a histogram and a summary for a latency SLO.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
