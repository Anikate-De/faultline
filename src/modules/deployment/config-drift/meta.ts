import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-config-drift",
  slug: "config-drift",
  title: "Config Drift",
  track: "deployment",
  order: 19,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["deployment-build-once"],
  tags: ["config drift", "reconciliation", "diff", "environment", "audit"],
  productionQuestion:
    "Staging and production behave differently after months of manual changes. How do you find drift?",
  learningDelta:
    "Drift is inevitable without reconciliation and comparison; config as code plus periodic diff reduces surprise",
  objectives: [
    "Define configuration drift and distinguish it from an intentional environment override.",
    "Explain how manual changes accumulate between reconciliation passes.",
    "Choose a diff and reconciliation cadence that fits the change rate.",
    "Design an audit path that explains a production-only setting.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
