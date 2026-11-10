import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-replication-lag",
  slug: "replication-lag",
  title: "Replication Lag and the Oplog",
  track: "mongodb",
  order: 6,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-replica-set"],
  tags: ["oplog", "capped collection", "replication lag", "resync", "write burst"],
  productionQuestion:
    "Replica lag grows during a write burst and then the secondary falls off the oplog. What happens?",
  learningDelta:
    "Secondaries apply the capped oplog; if they fall behind the window they need a full resync, not a quick catch-up",
  objectives: [
    "Relate write rate, oplog size, and entry size to the oplog window.",
    "Distinguish a secondary that is merely behind from one that has fallen off the oplog.",
    "Explain why falling off the oplog requires a full resync instead of incremental catch-up.",
    "Choose between reducing write load, increasing apply capacity, and enlarging the oplog.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
