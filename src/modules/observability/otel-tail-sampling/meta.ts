import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-otel-tail-sampling",
  slug: "otel-tail-sampling",
  title: "Tail Sampling: Keep the Interesting Traces",
  track: "observability",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-otel-head-sampling"],
  tags: ["tail sampling", "policy", "buffer", "latency threshold", "error rate", "collector"],
  productionQuestion:
    "Storage budget allows 2% of traces, but you need every timeout. How do you sample?",
  learningDelta:
    "Tail sampling buffers completed traces and applies policies, preserving errors and latency outliers at bounded volume",
  objectives: [
    "Size a tail-sampling buffer from arrival rate, decision wait, and collector count.",
    "Explain why a dropped trace never reaches a policy, even an error policy.",
    "Compare error, latency, and baseline policies by what they retain and cost.",
    "Recognize when the decision wait must grow to cover long traces.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
