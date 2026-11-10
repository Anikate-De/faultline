import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "deployment-blue-green-db-migration",
  slug: "blue-green-db-migration",
  title: "Blue-Green Database Migrations",
  track: "deployment",
  order: 7,
  difficulty: 4,
  minutes: 20,
  prerequisites: ["deployment-expand-contract"],
  tags: ["expand/contract", "backward compatible", "migration", "dual write", "cutover"],
  productionQuestion:
    "Both blue and green must run during cutover. How do you migrate the database?",
  learningDelta:
    "Blue-green schema changes require expand/contract compatibility so both versions can read and write during the transition",
  objectives: [
    "Explain why a blue-green cutover still leaves two code versions sharing one database.",
    "Sequence schema changes so both versions can read and write during the transition.",
    "Identify the point where a destructive change blocks rollback.",
    "Use dual writes and backfill coverage to protect old and new readers.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
