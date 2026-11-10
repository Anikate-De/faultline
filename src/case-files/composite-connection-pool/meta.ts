import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-connection-pool",
  slug: "composite-connection-pool",
  title: "Composite: The Pool Wait That Looked Like Slow Queries",
  track: "case-files",
  order: 49,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-connection-pools"],
  tags: ["connection pool", "wait time", "database", "latency", "metrics"],
  productionQuestion: "Query latency is 2 seconds in the app but 20ms in the database. Where is the time?",
  learningDelta:
    "Client-side pool wait can dominate latency while the database is healthy; measure acquisition time separately",
  objectives: [
    "Distinguish pool acquisition time from query execution time.",
    "Read pool occupancy and wait metrics alongside database health.",
    "Choose a mitigation that reduces hold time instead of only adding connections.",
    "Design instrumentation that makes queueing visible before saturation.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
