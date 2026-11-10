import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-expand-contract",
  slug: "expand-contract",
  title: "Expand/Contract Migrations",
  track: "deployment",
  order: 8,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["deployment-blue-green"],
  tags: ["expand", "contract", "backfill", "dual write", "compatibility"],
  productionQuestion: "A column rename breaks the previous release. How do you sequence it?",
  learningDelta:
    "Expand/contract adds the new shape, backfills, dual-writes, then removes the old shape; each step is independently deployable",
  objectives: [
    "Break a schema rename into expand, backfill, dual-write, and contract steps.",
    "Explain why each step must be independently deployable and reversible.",
    "Detect an incomplete backfill before it reaches new readers.",
    "Decide when the old code is drained enough to run the contract step.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
