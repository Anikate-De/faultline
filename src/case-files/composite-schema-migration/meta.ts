import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "case-composite-schema-migration",
  slug: "composite-schema-migration",
  title: "Composite: The Migration That Broke Rollback",
  track: "case-files",
  order: 33,
  difficulty: 4,
  minutes: 22,
  prerequisites: ["deployment-expand-contract"],
  tags: ["schema migration", "rollback", "compatibility", "expand/contract", "deploy"],
  productionQuestion:
    "A release adds a required column and rollback fails because the old code cannot read it. What was missing?",
  learningDelta:
    "Schema changes must be backward and forward compatible during the rollout window; expand/contract sequences the risk",
  objectives: [
    "Reconstruct how a schema-first rollout breaks the previous application version.",
    "Choose an immediate action when rollback is blocked by an irreversible migration.",
    "Sequence a schema change as expand, migrate, and contract.",
    "Design a compatibility gate that tests the previous version against the new schema.",
  ],
  interviewQuestions: 0,
  hasSim: false,
  caseStudy: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
