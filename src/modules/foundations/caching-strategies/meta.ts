import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-caching-strategies",
  slug: "caching-strategies",
  title: "Caching Strategies: Where the Write Goes",
  track: "foundations",
  order: 28,
  difficulty: 2,
  minutes: 18,
  prerequisites: ["foundations-consistency-models"],
  tags: ["cache-aside", "write-through", "write-behind", "TTL", "consistency"],
  productionQuestion:
    "The product needs fast reads and durable writes; which cache strategy fits?",
  learningDelta:
    "Cache-aside keeps the cache optional, write-through keeps it fresh at write cost, write-behind risks data loss",
  objectives: [
    "Compare cache-aside, write-through, and write-behind on the write path.",
    "Explain why write-behind can acknowledge a write that the cache then loses.",
    "Choose a strategy from a durability and freshness requirement, not from read latency alone.",
    "Name the failure behavior of each strategy when the cache is unavailable.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
