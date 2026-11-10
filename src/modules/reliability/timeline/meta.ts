import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-timeline",
  slug: "timeline",
  title: "Incident Timeline",
  track: "reliability",
  order: 29,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-incident-timeline"],
  tags: ["timeline", "timestamp", "source", "deploy", "decision"],
  productionQuestion:
    "Two teams disagree about when the rollback happened. How do you settle it?",
  learningDelta:
    "A timeline combines alerts, deploys, decisions, and communications with synchronized timestamps and sources",
  objectives: [
    "Build one incident chronology from alerts, deploys, decisions, and communications.",
    "Label each entry with its source and the basis for its timestamp.",
    "Resolve disagreements by comparing clocks and recording the remaining uncertainty.",
    "Explain why clock skew can make a cause look like an effect.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
