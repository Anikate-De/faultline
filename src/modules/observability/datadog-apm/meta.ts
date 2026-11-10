import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-datadog-apm",
  slug: "datadog-apm",
  title: "APM Sampling: See the Errors That Matter",
  track: "observability",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["observability-otel-tail-sampling"],
  tags: ["APM", "trace sampling", "retention", "error spans", "distributed tracing"],
  productionQuestion:
    "Trace sampling is 1% and a 0.2% error class is invisible. How do you sample?",
  learningDelta:
    "Uniform head sampling is cheap but blind to rare errors; retention and error-biased sampling preserve the traces you need",
  objectives: [
    "Distinguish head sampling from error-biased or tail sampling by what they can see.",
    "Compute the retained volume and rare-error visibility of a sampling plan.",
    "Explain why a low uniform sample rate can hide a rare error class.",
    "Choose a sampling and retention design that fits a trace budget.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
