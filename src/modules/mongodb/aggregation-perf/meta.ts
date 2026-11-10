import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-aggregation-perf",
  slug: "aggregation-perf",
  title: "Aggregation Pipeline Performance",
  track: "mongodb",
  order: 15,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-index-design"],
  tags: ["aggregation", "pipeline", "$match", "$sort", "memory limit", "allowDiskUse"],
  productionQuestion:
    "An aggregation pipeline is slow even with an index. Where is the work happening?",
  learningDelta:
    "Pipeline stage order determines whether indexes, memory, and disk are used; early filters and limits reduce work",
  objectives: [
    "Trace how many documents enter each stage of an aggregation pipeline.",
    "Explain why a $match after a blocking stage cannot use an index.",
    "Recognize the 100 MB per-stage memory limit and the effect of allowDiskUse.",
    "Reorder a pipeline so filters and limits reduce the work done by blocking stages.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
