import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-action-items",
  slug: "action-items",
  title: "Action Items That Land",
  track: "reliability",
  order: 10,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-blameless-postmortems"],
  tags: ["action item", "owner", "due date", "verification", "prioritization"],
  productionQuestion:
    "The last postmortem had 20 action items and none shipped. What do you change?",
  learningDelta:
    "Action items need an owner, due date, verification, and prioritization; unowned items are wishes",
  objectives: [
    "Write an action item that names an owner, a due date, and a verification.",
    "Prioritize prevention work against limited engineering capacity.",
    "Explain why a long, unprioritized action list produces recurrence.",
    "Track completion with evidence rather than a status field.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
