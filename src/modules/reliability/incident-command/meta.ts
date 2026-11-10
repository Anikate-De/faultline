import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-incident-command",
  slug: "incident-command",
  title: "Incident Command",
  track: "reliability",
  order: 1,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["foundations-use-red"],
  tags: ["incident command", "incident commander", "operations", "communications", "coordination"],
  productionQuestion:
    "Five engineers are debugging and no one is communicating. What role is missing?",
  learningDelta:
    "Incident command assigns one coordinator, one communications owner, and one operations owner so investigation and communication do not compete",
  objectives: [
    "Explain what an incident commander owns, and what that role does not own.",
    "Separate the command, operations, and communications responsibilities during an active incident.",
    "Recognize parallel debugging as a coordination failure, not a staffing shortage.",
    "Choose the smallest command structure that fits the incident's impact and duration.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
