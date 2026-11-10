import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-indexing",
  slug: "indexing",
  title: "Indexing: The Right Index for the Query",
  track: "databases",
  order: 18,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["databases-query-plans"],
  tags: ["index", "B-tree", "selectivity", "column order", "write cost", "covering index"],
  productionQuestion:
    "A query is slow and adding an index doubles write latency. What do you check?",
  learningDelta:
    "Indexes trade read speed for write cost and space; the query plan, selectivity, and column order decide whether an index helps",
  objectives: [
    "Predict whether a B-tree index can serve a predicate from its shape, not its name.",
    "Explain why a function on the indexed column makes a predicate non-sargable.",
    "Quantify the write and storage cost of each additional index on a write-heavy table.",
    "Choose between a composite, partial, or covering index for a specific query.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
