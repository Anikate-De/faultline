import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-dashboard-question",
  slug: "dashboard-question",
  title: "One Dashboard, One Decision",
  track: "observability",
  order: 23,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-grafana-dashboard"],
  tags: ["dashboard", "decision", "hierarchy", "runbook link", "annotation"],
  productionQuestion:
    "It is 3 a.m. and the dashboard has every metric but no next step. How do you redesign it?",
  learningDelta:
    "A useful dashboard orders signals by the decision they support and links the next check, not every available metric",
  objectives: [
    "Trace a slow incident decision to panel count, relevance, ordering, and missing links.",
    "Design a dashboard around one decision and its next check.",
    "Distinguish context panels from decision panels.",
    "Measure dashboard quality by time-to-decision rather than panel coverage.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
