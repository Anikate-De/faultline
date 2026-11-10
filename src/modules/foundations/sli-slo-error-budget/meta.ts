import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-sli-slo-error-budget",
  slug: "sli-slo-error-budget",
  title: "SLI, SLO, SLA, and the Error Budget",
  track: "foundations",
  order: 6,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-use-red"],
  tags: ["SLI", "SLO", "SLA", "error budget", "burn rate", "compliance window"],
  productionQuestion:
    "Your SLO is 99.9% and the month is half over; how much failure can you still spend?",
  learningDelta:
    "An error budget converts an SLO into an allowed failure quantity; burn rate tells you when to stop shipping",
  objectives: [
    "Define an SLI as a ratio of good events to valid events.",
    "Convert an SLO into an error budget for a compliance window.",
    "Use burn rate to decide whether to keep shipping.",
    "Explain why an SLA is not the same promise as an SLO.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
