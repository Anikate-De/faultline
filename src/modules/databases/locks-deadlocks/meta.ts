import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-locks-deadlocks",
  slug: "locks-deadlocks",
  title: "Locks and Deadlocks",
  track: "databases",
  order: 16,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-long-transactions"],
  tags: ["lock", "deadlock", "wait event", "pg_locks", "transaction order"],
  productionQuestion: "Writes hang and the database reports deadlocks. Which query do you inspect first?",
  learningDelta:
    "Lock waits and deadlocks come from transaction ordering; pg_locks and wait events reveal the blocker, but killing it has consequences",
  objectives: [
    "Distinguish a lock wait from a deadlock and explain why only one resolves itself.",
    "Use a wait graph to find the blocking session rather than the waiting one.",
    "Explain how consistent lock ordering prevents most deadlocks.",
    "Choose between waiting, canceling a statement, and terminating a session, with the rollback cost of each.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
