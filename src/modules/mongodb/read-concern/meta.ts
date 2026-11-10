import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-read-concern",
  slug: "read-concern",
  title: "Read Concern",
  track: "mongodb",
  order: 21,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["mongodb-write-concern"],
  tags: ["read concern", "local", "majority", "linearizable", "snapshot"],
  productionQuestion: "A read returns data that is later rolled back. Which read concern was used?",
  learningDelta:
    "Read concern controls the visibility and durability of reads; local can return data not yet majority-committed",
  objectives: [
    "Distinguish local, majority, linearizable, and snapshot read concern by what they guarantee.",
    "Explain how a local read can return a write that is later rolled back after a primary crash.",
    "Choose a read concern from the consistency and latency the product needs.",
    "Use causal sessions and maxTimeMS with the read concern that requires them.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
