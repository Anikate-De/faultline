import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-probabilistic-expiration",
  slug: "probabilistic-expiration",
  title: "Probabilistic Early Expiration",
  track: "caching",
  order: 11,
  difficulty: 3,
  minutes: 16,
  prerequisites: ["caching-cache-stampede"],
  tags: ["XFetch", "early expiration", "probability", "TTL", "refresh"],
  productionQuestion:
    "A hot key expires in sync across all app instances. How do you refresh early?",
  learningDelta:
    "Probabilistic early expiration spreads refreshes before TTL expiry, reducing synchronized misses at the cost of extra recomputation",
  objectives: [
    "Explain how XFetch turns a TTL edge into a probability that rises near expiry.",
    "Relate beta and recompute time to the early-refresh window and the extra recomputation it causes.",
    "Choose beta from a backend capacity and freshness budget rather than from a default.",
    "Recognize when early expiration cannot replace TTL jitter or request coalescing.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
