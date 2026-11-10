import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-change-management",
  slug: "change-management",
  title: "Change Management That Helps",
  track: "deployment",
  order: 14,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-rolling"],
  tags: ["change management", "risk", "reversibility", "approval", "ownership"],
  productionQuestion:
    "Every change needs five approvals and incidents still happen. What should change review focus on?",
  learningDelta:
    "Good change management reviews blast radius, reversibility, observability, and ownership; approval count is not risk control",
  objectives: [
    "Separate approval count from risk review coverage.",
    "Score change risk by blast radius, reversibility, observability, and ownership.",
    "Explain how reviewer capacity becomes a queue and delays every change.",
    "Redesign a review process that shortens lead time without hiding high-risk changes.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
