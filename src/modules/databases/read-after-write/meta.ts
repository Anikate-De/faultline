import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "databases-read-after-write",
  slug: "read-after-write",
  title: "Read-After-Write Consistency",
  track: "databases",
  order: 10,
  difficulty: 2,
  minutes: 16,
  prerequisites: ["databases-read-replica-routing"],
  tags: ["read-after-write", "session stickiness", "version token", "replica", "cache"],
  productionQuestion:
    "A user saves a setting and the next page load shows the old value. How do you fix it without going back to the primary for everything?",
  learningDelta:
    "Read-after-write requires routing the user's reads to a consistent source for a window, or propagating a version token",
  objectives: [
    "Separate a stale read from a lost write by checking the primary and the replica replay position.",
    "Choose between a sticky primary window, a version token, and primary-only reads for a read path.",
    "Size the consistency policy so only reads that need freshness pay for it.",
    "Explain how a cache adds a second staleness boundary after the replica catches up.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
