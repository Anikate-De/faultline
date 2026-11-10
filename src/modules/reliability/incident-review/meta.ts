import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-incident-review",
  slug: "incident-review",
  title: "Incident Review",
  track: "reliability",
  order: 32,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-blameless-postmortems"],
  tags: ["review", "facilitation", "contributing factor", "action", "blameless"],
  productionQuestion:
    "The review becomes a debate about who caused it. How do you run it?",
  learningDelta:
    "Incident reviews examine timeline, contributing factors, and actions; facilitation and blameless framing keep the focus on systems",
  objectives: [
    "Facilitate a review that follows evidence instead of the loudest theory.",
    "Keep discussion at the level of conditions and decisions under uncertainty.",
    "Convert disagreement into a recorded open question or a systemic action.",
    "Close the review with actions that match the contributing factors.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
