import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-blameless-postmortems",
  slug: "blameless-postmortems",
  title: "Blameless Postmortems",
  track: "reliability",
  order: 9,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["reliability-incident-command"],
  tags: ["blameless", "contributing factors", "systemic", "learning", "safety"],
  productionQuestion:
    "The postmortem names the engineer who ran the command and no one shares details. What is wrong?",
  learningDelta:
    "Blameless analysis focuses on conditions and system design; blame suppresses the information needed to prevent recurrence",
  objectives: [
    "Explain what blameless analysis changes and what it does not excuse.",
    "Rewrite an individual-focused statement as a set of contributing conditions.",
    "Recognize how blame reduces the information available to the review.",
    "Distinguish a contributing factor from a root cause and from an action item.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
