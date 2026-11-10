import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-index-design",
  slug: "index-design",
  title: "Index Design",
  track: "mongodb",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-indexing"],
  tags: ["compound index", "ESR rule", "selectivity", "sort", "index prefix"],
  productionQuestion:
    "A compound index is not used even though its fields appear in the query. Why?",
  learningDelta:
    "Index field order, sort direction, and predicate shape determine whether MongoDB can use an index efficiently",
  objectives: [
    "Read a compound index as an ordered list of keys, not a set of fields.",
    "Apply the equality-sort-range guideline to a query shape.",
    "Explain why an index whose fields all appear in a query can still be bypassed.",
    "Use scanned-document counts and explain output to validate a plan.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
