import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-n-plus-one",
  slug: "n-plus-one",
  title: "N+1 Queries: Count the Round Trips",
  track: "databases",
  order: 20,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["databases-query-plans"],
  tags: ["N+1", "batching", "join", "dataloader", "round trip", "latency"],
  productionQuestion: "A page loads 200 items and makes 201 queries. Where do you fix it?",
  learningDelta:
    "N+1 comes from per-item queries; batching, joins, or dataloaders reduce round trips and connection pressure",
  objectives: [
    "Count the round trips a page makes from its item count and per-item queries.",
    "Explain why p99 latency grows faster than the average as query count rises.",
    "Fix N+1 with a join, an IN batch, or a dataloader and state the tradeoff of each.",
    "Detect the pattern from query counts and connection pool pressure, not just slow query logs.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
