import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-read-preference",
  slug: "read-preference",
  title: "Read Preference",
  track: "mongodb",
  order: 2,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mongodb-replica-set"],
  tags: ["read preference", "primary", "secondary", "nearest", "staleness"],
  productionQuestion:
    "A dashboard reads from a lagging secondary and shows old data. Which read preference fits?",
  learningDelta:
    "Read preference trades freshness for locality and load; primary, primaryPreferred, secondary, and nearest have different failure behavior",
  objectives: [
    "Choose a read preference mode from the product's freshness and availability requirements.",
    "Explain how secondary reads become stale and how `maxStalenessSeconds` filters candidates.",
    "Distinguish primaryPreferred from secondaryPreferred when the primary fails.",
    "Recognize that nearest is a latency choice, not a freshness guarantee.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
