import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-grafana-dashboard",
  slug: "grafana-dashboard",
  title: "Dashboards That Answer One Question",
  track: "observability",
  order: 5,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["observability-golden-signals"],
  tags: ["dashboard design", "hierarchy", "thresholds", "annotations", "links"],
  productionQuestion:
    "An on-call engineer opens the dashboard and cannot decide whether to roll back. What is missing?",
  learningDelta:
    "A dashboard is a decision aid: one question, ordered signals, thresholds, and links to the next check",
  objectives: [
    "Name the single decision a dashboard exists to support.",
    "Order panels by the decision they unblock, not by data availability.",
    "Use thresholds and annotations to make an incident legible at a glance.",
    "Cut panels that add scanning time without changing the decision.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
