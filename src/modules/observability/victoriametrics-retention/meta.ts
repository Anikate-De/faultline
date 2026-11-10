import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-victoriametrics-retention",
  slug: "victoriametrics-retention",
  title: "Retention and Downsampling Tradeoffs",
  track: "observability",
  order: 11,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-victoriametrics-cardinality"],
  tags: ["retention", "downsampling", "resolution", "disk", "audit", "tiering"],
  productionQuestion:
    "Compliance needs one year, dashboards need 30 days, and disk is full. What do you keep?",
  learningDelta:
    "Retention tiers and downsampling preserve long-range trends while reducing resolution and cost",
  objectives: [
    "Separate the audit retention requirement from the dashboard retention requirement.",
    "Estimate disk from series count, sample interval, and retention tiers.",
    "Explain what downsampling preserves and what it loses.",
    "Design a retention policy that keeps required evidence and fits the disk budget.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
