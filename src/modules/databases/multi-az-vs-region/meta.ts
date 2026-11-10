import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-multi-az-vs-region",
  slug: "multi-az-vs-region",
  title: "Multi-AZ vs Multi-Region",
  track: "databases",
  order: 23,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-dr-drills"],
  tags: ["Multi-AZ", "multi-region", "synchronous", "asynchronous", "RTO", "RPO"],
  productionQuestion: "The business needs 99.99% and 15-minute RTO. Is Multi-AZ enough?",
  learningDelta:
    "Multi-AZ protects against an AZ failure with a synchronous standby; multi-region protects against a region failure with asynchronous lag and higher RTO",
  objectives: [
    "Distinguish the failure domain that each topology survives.",
    "Explain why Multi-AZ has RPO 0 for an AZ failure but cannot cover a region failure.",
    "Compare RTO and data loss across single-AZ, Multi-AZ, and multi-region.",
    "Defend the cost of multi-region against a stated availability and RTO target.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
