import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-datadog-tags",
  slug: "datadog-tags",
  title: "Datadog Tags and Cardinality",
  track: "observability",
  order: 6,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-use-red"],
  tags: ["tags", "cardinality", "time series", "custom metrics", "aggregation"],
  productionQuestion: "A new tag contains user IDs and the metric bill tripled. What happened?",
  learningDelta:
    "Each unique tag combination creates a time series; high-cardinality tags multiply storage, query cost, and billing",
  objectives: [
    "Trace a bill increase to the tag combinations that created new series.",
    "Estimate how a new tag multiplies series from host, endpoint, and value counts.",
    "Separate ingestion volume from indexed series when reading Datadog usage.",
    "Choose a cardinality control that keeps the query the product actually needs.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
