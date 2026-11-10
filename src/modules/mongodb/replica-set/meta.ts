import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-replica-set",
  slug: "replica-set",
  title: "MongoDB Replica Sets",
  track: "mongodb",
  order: 1,
  difficulty: 1,
  minutes: 16,
  prerequisites: ["databases-failover-dns"],
  tags: ["replica set", "primary", "secondary", "oplog", "election"],
  productionQuestion:
    "The primary disappears and the app reconnects to a new node. What happened underneath?",
  learningDelta:
    "A replica set elects one primary; secondaries apply the oplog, and clients discover topology changes",
  objectives: [
    "Describe how a primary, secondaries, and the oplog keep one writable copy of the data set.",
    "Explain why a majority of voting members is required before a new primary can accept writes.",
    "Trace what happens to client writes during an election and after a new primary appears.",
    "Identify stale client topology as a separate failure from the election itself.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
