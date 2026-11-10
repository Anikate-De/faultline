import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-kafka-lag",
  slug: "composite-kafka-lag",
  title: "Composite: Consumer Lag After a Deploy",
  track: "case-files",
  order: 24,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["streaming-consumer-lag"],
  tags: ["consumer lag", "deploy", "partition", "scaling", "rollback"],
  productionQuestion:
    "A deploy doubles processing time and lag grows by 10 minutes per hour. What is the first move?",
  learningDelta:
    "Consumer lag recovery depends on processing rate versus production rate; scaling cannot fix a slow single partition",
  objectives: [
    "Read lag as a rate problem: production rate minus consumption rate.",
    "Use rollback when a deploy changes per-record cost.",
    "Inspect per-partition lag before adding consumers.",
    "Bound retries and preserve ordering when a poison record blocks a partition.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
