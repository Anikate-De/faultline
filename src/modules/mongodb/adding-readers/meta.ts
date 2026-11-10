import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "mongodb-adding-readers",
  slug: "adding-readers",
  title: "Adding Readers During an Incident",
  track: "mongodb",
  order: 4,
  difficulty: 3,
  minutes: 20,
  prerequisites: ["mongodb-read-preference"],
  tags: ["MongoDB", "replica set", "initial sync", "read preference", "replication lag", "WiredTiger cache"],
  productionQuestion:
    "The primary is overloaded, so you add a secondary. Why did latency get worse?",
  learningDelta:
    "A new secondary performs an initial sync and then serves cold reads; it increases primary load and replication pressure before it helps",
  objectives: [
    "Trace how initial sync adds load to the primary and the replication path.",
    "Explain why a new secondary cannot reduce read pressure until sync completes and its cache warms.",
    "Choose between a secondary sync source, waiting for off-peak traffic, and routing reads.",
    "Decide when adding a reader is the wrong response to a write-bound primary.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
