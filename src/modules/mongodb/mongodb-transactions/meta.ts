import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-transactions",
  slug: "mongodb-transactions",
  title: "Transactions and Their Limits",
  track: "mongodb",
  order: 18,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-write-concern"],
  tags: ["transaction", "session", "timeout", "size limit", "snapshot"],
  productionQuestion: "A transaction spans 10 minutes and 50k documents. What breaks first?",
  learningDelta:
    "MongoDB transactions have time and size limits and hold resources; they are not a substitute for schema design",
  objectives: [
    "Explain what a multi-document transaction holds while it runs: a snapshot, locks, and cache.",
    "Identify the default lifetime limit and the cache error that aborts an oversized transaction.",
    "Separate a transaction boundary problem from a schema or query problem.",
    "Design a retry and abort path that keeps a failed transaction from becoming a retry loop.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
