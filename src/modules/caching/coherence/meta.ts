import type { ModuleMeta } from "@/content/types";

export const meta: ModuleMeta = {
  id: "caching-coherence",
  slug: "coherence",
  title: "Cache Coherence Across Instances",
  track: "caching",
  order: 14,
  difficulty: 3,
  minutes: 18,
  prerequisites: ["caching-local-cache"],
  tags: ["coherence", "pub/sub", "invalidation", "versioned keys", "TTL", "staleness"],
  productionQuestion:
    "An update reaches one instance and others serve stale data for minutes. How do you invalidate?",
  learningDelta:
    "Coherence requires invalidation or versioning across every cache layer; pub/sub is fast but lossy, so TTLs remain a backstop",
  objectives: [
    "Tell a delivery failure from a cache that never received an invalidation.",
    "Compare pub/sub, durable delivery, versioned keys, and TTL backstops by failure mode.",
    "Explain why a lossy invalidation path can look healthy at the broker and stale at the product.",
    "Design a coherence path whose stale window is bounded and observable.",
  ],
  interviewQuestions: 3,
  hasSim: true,
  status: "published",
  lastReviewed: "2026-11-10",
};
