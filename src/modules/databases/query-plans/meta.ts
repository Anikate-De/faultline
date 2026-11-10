import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-query-plans",
  slug: "query-plans",
  title: "Query Plans: Why the Index Is Ignored",
  track: "databases",
  order: 19,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-rds-aurora-arch"],
  tags: ["EXPLAIN", "planner", "statistics", "sequential scan", "cost", "selectivity"],
  productionQuestion: "An index exists but the planner chooses a sequential scan. Why?",
  learningDelta:
    "Plans depend on statistics, selectivity, cost, and predicates; stale stats or functions on columns defeat indexes",
  objectives: [
    "Read estimated rows, actual rows, and loop counts in EXPLAIN ANALYZE.",
    "Explain how stale statistics make a nested loop look cheap to the planner.",
    "Distinguish a plan that is wrong because of cost estimates from one that cannot use an index.",
    "Refresh statistics or rewrite a predicate without guessing at planner internals.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
