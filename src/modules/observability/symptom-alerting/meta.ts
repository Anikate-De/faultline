import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-symptom-alerting",
  slug: "symptom-alerting",
  title: "Symptom-Based Alerting",
  track: "observability",
  order: 20,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-slo-burn-rate"],
  tags: ["symptom", "cause", "SLO", "paging", "diagnosis", "noise"],
  productionQuestion:
    "The CPU alert pages every night at 2 a.m. and users are fine. What should page instead?",
  learningDelta:
    "Symptom alerts track SLO impact; cause alerts support diagnosis but create noise and do not prove user impact",
  objectives: [
    "Classify an alert as a symptom or a cause using the signal it measures.",
    "Compare page volume with user impact for each alert type.",
    "Explain why a high-CPU page with healthy latency and errors is a ticket, not a page.",
    "Redesign a paging policy around SLO impact while keeping cause signals for diagnosis.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
