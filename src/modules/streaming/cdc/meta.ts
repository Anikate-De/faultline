import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "streaming-cdc",
  slug: "cdc",
  title: "Change Data Capture",
  track: "streaming",
  order: 30,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["streaming-outbox"],
  tags: ["CDC", "binlog", "WAL", "snapshot", "schema change", "tombstone"],
  productionQuestion:
    "A downstream index lags by an hour because it polls the database. Can CDC help?",
  learningDelta:
    "CDC reads the database log and emits ordered changes; snapshotting, schema changes, and tombstones add complexity",
  objectives: [
    "Explain how log-based CDC differs from polling a table.",
    "Predict lag during an initial snapshot and after a schema change.",
    "Handle tombstones and deletes in a downstream projection.",
    "Choose CDC when ordering and freshness justify its operational cost.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
