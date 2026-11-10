import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-histogram-quantile",
  slug: "histogram-quantile",
  title: "Histogram Quantiles: Buckets Decide the Tail",
  track: "observability",
  order: 4,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-promql-rate"],
  tags: ["histogram", "bucket", "quantile", "interpolation", "native histogram", "tail"],
  productionQuestion: "The p99 panel says 200ms but traces show 2s requests. Which is wrong?",
  learningDelta:
    "Histogram quantiles are interpolated within buckets; poor bucket layout hides the tail and cannot exceed the largest bucket",
  objectives: [
    "Explain how histogram_quantile interpolates inside a bucket.",
    "Predict when a tail is invisible because it falls below the requested quantile.",
    "Recognize a p99 clamped by the highest finite bucket.",
    "Choose a bucket layout or native histogram for the tail you need to see.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
