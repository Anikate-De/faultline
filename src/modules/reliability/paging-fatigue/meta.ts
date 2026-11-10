import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-paging-fatigue",
  slug: "paging-fatigue",
  title: "Paging Fatigue",
  track: "reliability",
  order: 12,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-alert-fatigue"],
  tags: ["paging fatigue", "actionable", "page load", "detection", "rotation"],
  productionQuestion:
    "On-call receives 80 pages a week and misses the real one. What do you measure?",
  learningDelta:
    "Page load must be actionable and bounded; measure pages per shift and the fraction that lead to action, not raw alert count",
  objectives: [
    "Measure page load per shift instead of counting raw alerts.",
    "Distinguish actionable pages from noise and from missed detection.",
    "Explain why a larger rotation redistributes fatigue but does not remove it.",
    "Design a paging change that lowers volume without lowering detection.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
