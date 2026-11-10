import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-peak-race",
  slug: "composite-peak-race",
  title: "Composite: The Scheduled Scale-Down During a Surge",
  track: "case-files",
  order: 47,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["capacity-scheduled-scaling-race"],
  tags: ["scheduled scaling", "race", "minimum capacity", "surge", "guardrail"],
  productionQuestion:
    "A scheduled scale-down runs at 18:00 while a viral surge is starting. What guardrail was missing?",
  learningDelta:
    "Scheduled scaling must respect minimum capacity, cooldowns, and change freezes; dynamic demand can invalidate a schedule",
  objectives: [
    "Separate a scheduled capacity action from the demand change that made it unsafe.",
    "Choose a first mitigation that restores capacity without fighting the autoscaler.",
    "Design a capacity floor and ownership model that survives schedule changes.",
    "Explain why a cooldown is not a guardrail against a demand surge.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
