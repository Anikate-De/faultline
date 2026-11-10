import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-pgbouncer",
  slug: "pgbouncer",
  title: "PgBouncer: Pool Before the Database",
  track: "databases",
  order: 7,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-max-connections"],
  tags: ["PgBouncer", "transaction pooling", "session pooling", "prepared statements", "connections"],
  productionQuestion:
    "200 app tasks each open 20 connections and the database refuses new ones. How do you pool?",
  learningDelta:
    "PgBouncer multiplexes client connections onto fewer server connections; transaction pooling breaks session-level features",
  objectives: [
    "Size a PgBouncer pool from client concurrency and the database connection limit.",
    "Distinguish session pooling from transaction pooling and name what transaction pooling breaks.",
    "Diagnose session-state failures that appear only after transaction pooling is enabled.",
    "Decide when to change the application instead of increasing the pool size.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
