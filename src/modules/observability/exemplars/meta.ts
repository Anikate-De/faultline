import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-exemplars",
  slug: "exemplars",
  title: "Exemplars: From Metric to Trace",
  track: "observability",
  order: 30,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["observability-distributed-tracing"],
  tags: ["exemplar", "trace ID", "histogram", "sampling", "correlation"],
  productionQuestion:
    "p99 is high and you need one concrete slow request. How do you get from the graph to the trace?",
  learningDelta:
    "Exemplars attach trace IDs to metric samples, connecting aggregates to individual requests without storing every trace",
  objectives: [
    "Explain what an exemplar stores and why it is not a substitute for a histogram bucket.",
    "Trace a slow bucket to a sampled request and name the two conditions that must both hold.",
    "Diagnose a missing exemplar without blaming the histogram or the query.",
    "Choose a trace sample rate that preserves links for the investigations you support.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
