import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-cardinality-bill",
  slug: "composite-cardinality-bill",
  title: "Composite: The Tag That Tripled the Bill",
  track: "case-files",
  order: 35,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["observability-datadog-tags"],
  tags: ["cardinality", "tags", "cost", "query latency", "ownership"],
  productionQuestion:
    "The observability bill triples after a release and dashboards slow down. What changed?",
  learningDelta:
    "A high-cardinality tag multiplies series and cost; cost anomalies should page the owning team, not just finance",
  objectives: [
    "Find the metric and label that multiplied active series.",
    "Choose an ingestion-side mitigation that preserves diagnosis.",
    "Replace high-cardinality tags with traces, logs, or exemplars.",
    "Set a cardinality budget with an owning team and an alert.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
