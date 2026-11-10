import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-postmortem-actions",
  slug: "postmortem-actions",
  title: "Postmortem Action Quality",
  track: "reliability",
  order: 31,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["reliability-action-items"],
  tags: ["action", "systemic", "verification", "contributing factor", "recurrence"],
  productionQuestion:
    "The action is “be more careful” and the incident recurs. Why?",
  learningDelta:
    "Good actions change systems, have verification, and address contributing factors; human vigilance is not a control",
  objectives: [
    "Rewrite vigilance advice as a change to a system condition.",
    "Attach a verification that would fail if the condition returned.",
    "Cover the contributing factors rather than the most visible symptom.",
    "Explain why unverified actions produce recurrence even when they ship.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
