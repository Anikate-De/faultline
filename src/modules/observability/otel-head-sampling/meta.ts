import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-otel-head-sampling",
  slug: "otel-head-sampling",
  title: "Head Sampling: Cheap and Blind",
  track: "observability",
  order: 13,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-otel-context"],
  tags: ["head sampling", "probability", "trace volume", "error visibility", "cost"],
  productionQuestion:
    "A 5% head sample makes a rare error class invisible. What is the tradeoff?",
  learningDelta:
    "Head sampling decides before the request outcome is known; it is cheap and unbiased for volume but unreliable for rare outcomes",
  objectives: [
    "Explain why a head sampler cannot select a trace by its eventual error or latency.",
    "Estimate captured error spans from request rate, error share, sampling rate, and window.",
    "Read a blind-spot probability instead of trusting a low sampled error count.",
    "Choose a sampling rate that fits a span budget and state what it cannot answer.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
