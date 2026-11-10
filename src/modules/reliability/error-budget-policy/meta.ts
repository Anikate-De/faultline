import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "reliability-error-budget-policy",
  slug: "error-budget-policy",
  title: "Error Budget Policy",
  track: "reliability",
  order: 13,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["foundations-sli-slo-error-budget"],
  tags: ["error budget policy", "consequence", "exception", "freeze", "decision"],
  productionQuestion:
    "The error budget is exhausted but the roadmap says ship. Who decides?",
  learningDelta:
    "An error budget policy pre-agrees consequences and exceptions; without it, the budget is only a dashboard",
  objectives: [
    "Distinguish an error budget from an error budget policy.",
    "Write a policy with a trigger, a consequence, an exception path, and an owner.",
    "Explain why an exception needs a decision, a time limit, and a record.",
    "Defend a release freeze without turning the policy into an absolute ban.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
