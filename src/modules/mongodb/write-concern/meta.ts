import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-write-concern",
  slug: "write-concern",
  title: "Write Concern",
  track: "mongodb",
  order: 3,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["mongodb-replica-set"],
  tags: ["write concern", "w:majority", "journal", "acknowledgment", "durability"],
  productionQuestion:
    "A write is acknowledged and then lost after a primary crash. What write concern was used?",
  learningDelta:
    "Write concern controls how many nodes acknowledge before success; w:1 is fast but can lose writes on failover",
  objectives: [
    "Explain what `w:1`, `w:2`, and `w:\"majority\"` wait for before returning success.",
    "Distinguish journal durability on one node from replication to a majority.",
    "Predict which acknowledged writes can be lost when the primary is replaced.",
    "Choose a write concern from the product's durability and latency requirements.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
