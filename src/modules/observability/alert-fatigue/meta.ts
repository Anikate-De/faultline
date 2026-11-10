import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "observability-alert-fatigue",
  slug: "alert-fatigue",
  title: "Alert Fatigue: Measure Actionability",
  track: "observability",
  order: 21,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["observability-symptom-alerting"],
  tags: ["alert fatigue", "actionability", "paging", "threshold", "ownership"],
  productionQuestion:
    "The team gets 60 pages a week and ignores half. Which alerts should exist?",
  learningDelta:
    "Alert quality is measured by actionable pages per incident; every noisy page trains responders to ignore the next one",
  objectives: [
    "Separate page volume from the number of actionable pages.",
    "Measure missed incidents alongside pager load instead of optimizing one number.",
    "Explain how rule count, thresholds, deduplication, and ownership change the queue.",
    "Choose which alerts should page, which should ticket, and who owns each.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
