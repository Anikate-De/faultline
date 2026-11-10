import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-read-replica-routing",
  slug: "read-replica-routing",
  title: "Read Replica Routing Without Stale Reads",
  track: "databases",
  order: 3,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["databases-primary-replica-lag"],
  tags: ["read routing", "read-your-writes", "session consistency", "replica", "stale read"],
  productionQuestion:
    "A user updates a profile and immediately reads an old value from a replica. How do you route?",
  learningDelta:
    "Read routing must respect read-your-writes; sticky-to-primary windows, session consistency, or write-through caches solve different cases",
  objectives: [
    "Route reads by consistency requirement instead of one global read/write split.",
    "Design a read-your-writes rule using a post-write primary window or a version boundary.",
    "Quantify the writer capacity cost of stickiness and the staleness cost of replica reads.",
    "Choose between sticky sessions, version tokens, and write-through caches for different read paths.",
  ],
  interviewQuestions: 4,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
