import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "foundations-cache-invalidation",
  slug: "cache-invalidation",
  title: "Cache Invalidation: Coherence Without Guessing",
  track: "foundations",
  order: 29,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["foundations-caching-strategies"],
  tags: ["invalidation", "pub/sub", "versioned keys", "TTL", "coherence", "stale read"],
  productionQuestion:
    "An update lands on one instance and other instances serve stale data for minutes; how do you invalidate?",
  learningDelta:
    "Invalidation is a distributed coherence problem; pub/sub, versioned keys, and short TTLs trade freshness for complexity",
  objectives: [
    "Explain why a local cache and a shared cache have different coherence paths.",
    "Compare TTL expiry, pub/sub invalidation, and versioned keys on freshness and complexity.",
    "Diagnose a stale read from the write, invalidation, and delivery path.",
    "Design a fallback for a missed invalidation message.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
