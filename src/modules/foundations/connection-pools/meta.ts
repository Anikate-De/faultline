import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-connection-pools",
  slug: "connection-pools",
  title: "Connection Pools: Queue Before the Database",
  track: "foundations",
  order: 25,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-queueing-knee"],
  tags: ["pool size", "wait queue", "max connections", "multiplexing", "session state"],
  productionQuestion:
    "The database allows 500 connections and the service has 40 tasks; what pool size?",
  learningDelta:
    "Pool size is a queueing decision; too small waits, too large multiplies database sessions and contention",
  objectives: [
    "Size a pool from per-task concurrency, query time, and database connection limits.",
    "Separate pool acquisition wait from query execution time using metrics and traces.",
    "Predict when adding pool capacity shifts the bottleneck to the database.",
    "Choose between a client pool and a multiplexing proxy using session-state requirements.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
