import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-lead-time",
  slug: "lead-time",
  title: "Lead Time for Changes",
  track: "deployment",
  order: 27,
  difficulty: 2,
  minutes: 14,
  prerequisites: ["deployment-cicd"],
  tags: ["lead time", "queue", "approval", "test duration", "DORA"],
  productionQuestion:
    "A one-line fix takes two weeks to reach production. Where is the time spent?",
  learningDelta:
    "Lead time is dominated by queues, approvals, and test duration; optimize the constraint, not the average",
  objectives: [
    "Break lead time into coding, queue, test, and deployment components.",
    "Identify the constraint that dominates a slow change.",
    "Explain why optimizing a non-constraint does not reduce lead time.",
    "Choose a change that shortens the queue without removing safety.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
