import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-game-days",
  slug: "game-days",
  title: "Game Days",
  track: "reliability",
  order: 15,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-error-budget-policy"],
  tags: ["game day", "scenario", "roles", "communication", "debrief"],
  productionQuestion:
    "The team knows the system but has never practiced an incident together. What does a game day test?",
  learningDelta:
    "Game days combine a realistic scenario, roles, communications, and a debrief; they test people and process as much as technology",
  objectives: [
    "Design a game day scenario with realistic injects and a clear scope.",
    "Assign roles that separate command, operations, communications, and record-keeping.",
    "Explain why a debrief with owners matters more than the failure itself.",
    "Recognize the coordination gaps a game day exposes before a real incident does.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
