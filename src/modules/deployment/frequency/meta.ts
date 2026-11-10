import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-frequency",
  slug: "frequency",
  title: "Deployment Frequency",
  track: "deployment",
  order: 26,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-cicd"],
  tags: ["deployment frequency", "batch size", "risk", "rollback", "DORA"],
  productionQuestion:
    "The team deploys monthly and every deploy is an incident. What changes first?",
  learningDelta:
    "Frequent small deploys reduce change size and improve recovery; the constraint is often test and rollback capability, not deploy tooling",
  objectives: [
    "Explain why deploy frequency and change size move together.",
    "Relate batch size to change failure rate and recovery time.",
    "Identify test and rollback capability as the constraint on frequency.",
    "Choose the next improvement when deploys are large and risky.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
